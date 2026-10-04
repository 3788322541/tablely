/**
 * Wholesale 读写（M10）—— 批发门控 + 客户组管理（B11）
 *
 * 职责边界：
 *   · **门控配置**（`ShopSettings.gateMode` / `gateTags` → `tablely.settings` 契约的 `gate`）——
 *     只存「模式 + 合格标签」，**不存「某位顾客是否可见」**（静态 metafield 表达不了，
 *     那是 Liquid 按 `customer.tags` + 登录态逐请求判定的，§2.4 / §五）。
 *   · **客户组 CRUD**（`CustomerGroup`）—— 每个组映射一个 Shopify 客户标签；
 *     改标签会让既有 `WholesalePrice.groupTag` 失联，故**同一事务内迁移**，
 *     保证「客户组改名后批发价仍生效」（§16.4 / M10 验收）。
 *
 * 本模块**不判套餐以外的业务**：Pro 门控（`gating` / `customer_groups`）在此后端拒写（§19.3），
 * 与前端禁 UI 共用 `hasFeature` 单点判定。
 *
 * 硬约束：`shop` 一律由调用方从 `session` 传入（§8.2 A），本模块不自行解析请求。
 */

import { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { hasFeature } from "../plan";
import {
    GATE_MODES,
    TIER_MODELS,
    normalizeTiers,
    type GraphqlAdmin,
    type TierEntry,
} from "./metafield.server";
import { ensureShopSettings, pushShopSettingsMetafield } from "./settings.server";
import { ensureDiscountsForShop } from "./discounts.server";
import {
    gidToNumericId,
    listProductVariants,
    pushProductTableMetafield,
    resolvePlan,
    TablelyError,
} from "./tables.server";

/** 门控模式（与契约白名单同源） */
export type GateMode = (typeof GATE_MODES)[number];

/** 门控判定结果：正常 / 只隐藏价 / 隐藏整表 */
export type GateDecision = "show" | "price_hidden" | "table_hidden";

/** 客户组标签 / 名称的长度上限（与 i18n 报错一致） */
const NAME_MAX = 60;
const TAG_MAX = 60;
const NOTE_MAX = 200;

/* ============================== 纯函数 ============================== */

/** 标签归一化：trim → 去空 → 去重（保留首次出现顺序） */
export function normalizeTags(values: readonly unknown[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        if (typeof value !== "string") continue;
        const tag = value.trim();
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
    }
    return out;
}

/** 门控模式归一化（非白名单一律退回 `off`，不把脏值写进契约） */
export function normalizeGateMode(value: unknown): GateMode {
    return (GATE_MODES as readonly string[]).includes(value as string)
        ? (value as GateMode)
        : "off";
}

/**
 * 门控判定（纯函数）—— Liquid 侧同口径实现的对照真源，供单测与后台提示复用。
 *
 * 口径（§1.4 #19 / §16.4 规则 2）：
 *   · `off` → 所有人可见；
 *   · 合格 = **已登录** 且 `customer.tags` 命中 `tags` 任一；
 *   · 不合格时按模式：`hide_price` → 只隐藏价；`hide_table` → 整表不渲染（原生加购保持可见）；
 *   · `tags` 为空视为无人合格（保存侧已拦「非 off 且空标签」，此处只是兜底）。
 */
export function gateDecision(input: {
    mode: unknown;
    tags: readonly unknown[];
    customerTags: readonly unknown[];
    loggedIn: boolean;
}): GateDecision {
    const mode = normalizeGateMode(input.mode);
    if (mode === "off") return "show";

    const hidden: GateDecision = mode === "hide_table" ? "table_hidden" : "price_hidden";
    const allowed = new Set(normalizeTags(input.tags));
    if (allowed.size === 0) return hidden;
    if (!input.loggedIn) return hidden;

    const qualified = normalizeTags(input.customerTags).some((tag) => allowed.has(tag));
    return qualified ? "show" : hidden;
}

/* ---------------------------- 归一化 / 校验 ---------------------------- */

function normalizeGroupName(raw: unknown): string {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) throw new TablelyError("error.groupNameRequired", "name");
    if (name.length > NAME_MAX) throw new TablelyError("error.groupNameTooLong", "name");
    return name;
}

function normalizeGroupTag(raw: unknown): string {
    const tag = typeof raw === "string" ? raw.trim() : "";
    if (!tag) throw new TablelyError("error.groupTagRequired", "tag");
    if (tag.length > TAG_MAX) throw new TablelyError("error.groupTagTooLong", "tag");
    // 空白会破坏精确匹配（`customer.tags` 里的标签不含空格），提前拦掉避免「配了不生效」
    if (/\s/.test(tag)) throw new TablelyError("error.groupTagInvalid", "tag");
    return tag;
}

function normalizeNote(raw: unknown): string | null {
    const note = typeof raw === "string" ? raw.trim() : "";
    if (!note) return null;
    return note.length > NOTE_MAX ? note.slice(0, NOTE_MAX) : note;
}

/* ============================== 门控配置 ============================== */

export type GateSettings = { mode: GateMode; tags: string[] };

/** 读取门控配置（不存在时建立默认行；返回值已归一化） */
export async function getGateSettings(shop: string): Promise<GateSettings> {
    const row = await ensureShopSettings(shop);
    return {
        mode: normalizeGateMode(row.gateMode),
        tags: normalizeTags(row.gateTags ?? []),
    };
}

/**
 * 保存门控配置：写 `ShopSettings.gateMode` / `gateTags` → 下发 Shop 级 metafield。
 *
 * 归零保护：模式非 `off` 时**至少一个合格标签**，否则会把包括批发客在内的所有顾客一起挡在外面
 * （与 §2.8「绝不出现没有加购入口」的安全取向一致）。
 */
export async function saveGateSettings(input: {
    admin: GraphqlAdmin;
    shop: string;
    mode: unknown;
    tags: readonly unknown[];
}): Promise<GateSettings> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "gating")) throw new TablelyError("error.proRequired");

    const mode = normalizeGateMode(input.mode);
    const tags = normalizeTags(input.tags);
    if (mode !== "off" && tags.length === 0) {
        throw new TablelyError("error.gateTagsRequired", "gateTags");
    }

    await ensureShopSettings(input.shop);
    await prisma.shopSettings.update({
        where: { shop: input.shop },
        data: { gateMode: mode, gateTags: tags },
    });

    await pushShopSettingsMetafield({ admin: input.admin, shop: input.shop });
    return { mode, tags };
}

/* ============================== 客户组 ============================== */

export type CustomerGroupRecord = {
    id: string;
    name: string;
    tag: string;
    note: string | null;
    sortOrder: number;
    /** 引用该组标签的批发价行数（§16.4：删除前提示「N 个变体批发价将失效」） */
    priceCount: number;
};

/** 按 `groupTag` 统计本店批发价行数（客户组列表 / 删除提示共用） */
async function countWholesalePricesByTag(shop: string): Promise<Map<string, number>> {
    const rows = await prisma.wholesalePrice.groupBy({
        by: ["groupTag"],
        where: { shop },
        _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.groupTag, row._count._all]));
}

/** 客户组列表（含各自被引用的批发价行数），按 `sortOrder` 升序 */
export async function listCustomerGroups(shop: string): Promise<CustomerGroupRecord[]> {
    const [groups, counts] = await Promise.all([
        prisma.customerGroup.findMany({
            where: { shop },
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        }),
        countWholesalePricesByTag(shop),
    ]);
    return groups.map((group) => ({
        id: group.id,
        name: group.name,
        tag: group.tag,
        note: group.note,
        sortOrder: group.sortOrder,
        priceCount: counts.get(group.tag) ?? 0,
    }));
}

/** 新建客户组（Pro）；标签在本店必须唯一（`@@unique([shop, tag])`） */
export async function createCustomerGroup(input: {
    shop: string;
    name: unknown;
    tag: unknown;
    note?: unknown;
}): Promise<CustomerGroupRecord> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "customer_groups")) throw new TablelyError("error.proRequired");

    const name = normalizeGroupName(input.name);
    const tag = normalizeGroupTag(input.tag);
    const note = normalizeNote(input.note);

    const existing = await prisma.customerGroup.findUnique({
        where: { shop_tag: { shop: input.shop, tag } },
        select: { id: true },
    });
    if (existing) throw new TablelyError("error.groupTagTaken", "tag");

    const last = await prisma.customerGroup.findFirst({
        where: { shop: input.shop },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
    });

    const created = await prisma.customerGroup.create({
        data: {
            shop: input.shop,
            name,
            tag,
            note,
            sortOrder: (last?.sortOrder ?? 0) + 1,
        },
    });

    return {
        id: created.id,
        name: created.name,
        tag: created.tag,
        note: created.note,
        sortOrder: created.sortOrder,
        priceCount: 0,
    };
}

/**
 * 更新客户组（Pro）：改名 / 改标签 / 改备注。
 *
 * **改标签的关键点**：同一事务内把引用旧标签的 `WholesalePrice` 迁到新标签，
 * 否则「客户组改名后批发价不生效」（§16.4 / M10 验收）。迁移是幂等的整批 `updateMany`。
 */
export async function updateCustomerGroup(input: {
    shop: string;
    id: string;
    name: unknown;
    tag: unknown;
    note?: unknown;
}): Promise<CustomerGroupRecord> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "customer_groups")) throw new TablelyError("error.proRequired");

    const existing = await prisma.customerGroup.findFirst({
        where: { id: input.id, shop: input.shop },
    });
    if (!existing) throw new TablelyError("error.notFound");

    const name = normalizeGroupName(input.name);
    const tag = normalizeGroupTag(input.tag);
    const note = normalizeNote(input.note);
    const tagChanged = tag !== existing.tag;

    if (tagChanged) {
        const clash = await prisma.customerGroup.findUnique({
            where: { shop_tag: { shop: input.shop, tag } },
            select: { id: true },
        });
        if (clash && clash.id !== existing.id) {
            throw new TablelyError("error.groupTagTaken", "tag");
        }
    }

    await prisma.$transaction(async (tx) => {
        if (tagChanged) {
            await tx.wholesalePrice.updateMany({
                where: { shop: input.shop, groupTag: existing.tag },
                data: { groupTag: tag },
            });
        }
        await tx.customerGroup.update({
            where: { id: existing.id },
            data: { name, tag, note },
        });
    });

    const counts = await countWholesalePricesByTag(input.shop);
    return {
        id: existing.id,
        name,
        tag,
        note,
        sortOrder: existing.sortOrder,
        priceCount: counts.get(tag) ?? 0,
    };
}

/**
 * 删除客户组（Pro）：同一事务内**先删引用该标签的批发价行、再删组**。
 *
 * 与 §16.4 的提示口径一致 —— 「引用该组的 N 个变体批发价将失效」，
 * 故这里确实把这 N 行一并删除（否则会留下无法在后台管理、却仍在店面生效的孤儿价）。
 * 路由侧在确认前用 `listCustomerGroups` 的 `priceCount` 给出 N。
 */
export async function deleteCustomerGroup(input: {
    shop: string;
    id: string;
}): Promise<{ deletedPrices: number }> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "customer_groups")) throw new TablelyError("error.proRequired");

    const existing = await prisma.customerGroup.findFirst({
        where: { id: input.id, shop: input.shop },
    });
    if (!existing) throw new TablelyError("error.notFound");

    return prisma.$transaction(async (tx) => {
        const removed = await tx.wholesalePrice.deleteMany({
            where: { shop: input.shop, groupTag: existing.tag },
        });
        await tx.customerGroup.delete({ where: { id: existing.id } });
        return { deletedPrices: removed.count };
    });
}

/** 客户组标签集合（门控下拉的可选集：已保存标签 ∪ 现有客户组标签） */
export function collectTagOptions(gate: GateSettings, groups: CustomerGroupRecord[]): string[] {
    return normalizeTags([...gate.tags, ...groups.map((group) => group.tag)]);
}

/* ======================== 阶梯价 / 批发价 / 混单（M12） ======================== */
/* 本节三个子能力都遵守同一条硬约束：任何一次保存成功后必须
 *   ① 重建并下发受影响的 product metafield（Function 从 `tablely.table` 读档位 / 批发价）；
 *   ② 调 `ensureDiscountsForShop` 刷新 3 个 automatic discount 的 config metafield。
 * 这样「改规则无需重新部署」才成立（§2.2.1 / §十二 验收 13）。
 *
 * 为什么保存后一定重下发：Function 运行在 Shopify 沙箱、读不到我们的 Postgres，
 * 它只看 **product metafield** 与 **discount function metafield** 两条投递路（§2.2.1）。 */

/** 金额 / 单价字符串的十进制边界（最多 8 位整数 + 2 位小数，与 Decimal(10,2) 对齐） */
const PRICE_RE = /^\d{1,8}(\.\d{1,2})?$/;

/** 单个商品的档位 JSON 上限（§2.2.1「写入前做大小校验，不允许静默截断」） */
const TIER_JSON_MAX = 5000;

/** 布尔归一化：兼容 `true` / `"true"` / `"1"` / `"on"`（表单勾选态由隐藏域携带） */
function toBool(value: unknown): boolean {
    return value === true || value === "true" || value === "1" || value === "on";
}

/* ------------------------------ 阶梯价 ------------------------------ */

/** 阶梯价模型（与契约白名单同源：`percent` = 模型 A，`fixed` = 模型 B，§2.2） */
export type TierModel = (typeof TIER_MODELS)[number];

/** 模型归一化（非白名单退回 `percent`，不把脏值写进契约） */
export function normalizeTierModel(value: unknown): TierModel {
    return (TIER_MODELS as readonly string[]).includes(value as string)
        ? (value as TierModel)
        : "percent";
}

export type TierSettings = { enabled: boolean; model: TierModel };

/** 读取阶梯价总开关与模型（不存在时建立默认行；返回值已归一化） */
export async function getTierSettings(shop: string): Promise<TierSettings> {
    const row = await ensureShopSettings(shop);
    return {
        enabled: Boolean(row.tierEnabled),
        model: normalizeTierModel(row.tierModel),
    };
}

/**
 * 校验并归一化档位行（**纯函数**，供保存 / 套用与单测共用，避免两套标准）。
 *
 * - 整行留空（qty 与 percent / price 都为空）→ 跳过，允许表格里留空行；
 * - `qty` 必须是 ≥ 1 的整数，否则 `error.tierQtyInvalid`；
 * - `percent` 模型要求 `0 < percent ≤ 100`，否则 `error.tierPercentInvalid`；
 * - `fixed` 模型要求价格串匹配十进制边界，否则 `error.tierPriceInvalid`；
 * - 结果按 `qty` 升序、同 `qty` 后者覆盖；序列化超 `TIER_JSON_MAX` 抛 `error.tierTooLarge`。
 */
export function validateTierRows(raw: unknown, model: TierModel): TierEntry[] {
    const rows = Array.isArray(raw) ? raw : [];
    const byQty = new Map<number, TierEntry>();

    for (const item of rows) {
        if (!item || typeof item !== "object") continue;
        const source = item as Record<string, unknown>;
        const asText = (value: unknown): string =>
            typeof value === "string"
                ? value.trim()
                : value === null || value === undefined
                    ? ""
                    : String(value).trim();

        const qtyText = asText(source.qty);
        const percentText = asText(source.percent);
        const priceText = asText(source.price);
        if (!qtyText && !percentText && !priceText) continue;

        if (!/^\d+$/.test(qtyText)) {
            throw new TablelyError("error.tierQtyInvalid", "tierQty");
        }
        const qty = Number.parseInt(qtyText, 10);
        if (!Number.isFinite(qty) || qty < 1) {
            throw new TablelyError("error.tierQtyInvalid", "tierQty");
        }

        if (model === "percent") {
            const percent = Number(percentText);
            if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
                throw new TablelyError("error.tierPercentInvalid", "tierPercent");
            }
            byQty.set(qty, { qty, percent });
        } else {
            if (!PRICE_RE.test(priceText)) {
                throw new TablelyError("error.tierPriceInvalid", "tierPrice");
            }
            byQty.set(qty, { qty, price: priceText });
        }
    }

    const tiers = [...byQty.values()].sort((a, b) => a.qty - b.qty);
    if (JSON.stringify(tiers).length > TIER_JSON_MAX) {
        throw new TablelyError("error.tierTooLarge");
    }
    return tiers;
}

/**
 * 保存阶梯价总开关与模型（Pro）：写 `ShopSettings` → 下发 Shop 级 metafield。
 *
 * 开关 / 模型属**全局项**，Function 从 discount 自身的 function metafield 读（§2.2.1），
 * 故保存后必须 `ensureDiscountsForShop` 刷新三份 config。
 */
export async function saveTierSettings(input: {
    admin: GraphqlAdmin;
    shop: string;
    enabled: unknown;
    model: unknown;
}): Promise<TierSettings> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "tier_pricing")) throw new TablelyError("error.proRequired");

    const enabled = toBool(input.enabled);
    const model = normalizeTierModel(input.model);

    await ensureShopSettings(input.shop);
    await prisma.shopSettings.update({
        where: { shop: input.shop },
        data: { tierEnabled: enabled, tierModel: model },
    });

    await pushShopSettingsMetafield({ admin: input.admin, shop: input.shop });
    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
    return { enabled, model };
}

export type TierProductRow = { productId: string; tiers: TierEntry[] };

/** 已配置订购表的商品及其商品级默认档位（`defaultTiers` 已归一化） */
export async function listTierProducts(shop: string): Promise<TierProductRow[]> {
    const rows = await prisma.productTable.findMany({
        where: { shop },
        orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
    });
    return rows.map((row) => ({
        productId: row.productId,
        tiers: normalizeTiers(row.defaultTiers),
    }));
}

/**
 * 保存某商品的商品级默认档位（Pro）：校验 → 写 `ProductTable.defaultTiers`
 * → 重下发该商品 metafield → 刷新折扣（§16.2「商品级可设默认档位表并向下继承」）。
 */
export async function saveProductTiers(input: {
    admin: GraphqlAdmin;
    shop: string;
    productId: string;
    tiers: unknown;
}): Promise<TierEntry[]> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "tier_pricing")) throw new TablelyError("error.proRequired");

    const { model } = await getTierSettings(input.shop);
    const tiers = validateTierRows(input.tiers, model);

    const existing = await prisma.productTable.findUnique({
        where: { shop_productId: { shop: input.shop, productId: input.productId } },
        select: { id: true },
    });
    if (!existing) throw new TablelyError("error.notFound");

    await prisma.productTable.update({
        where: { shop_productId: { shop: input.shop, productId: input.productId } },
        data: { defaultTiers: tiers as unknown as Prisma.InputJsonValue },
    });

    await pushProductTableMetafield({
        admin: input.admin,
        shop: input.shop,
        productId: input.productId,
    });
    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
    return tiers;
}

/**
 * 把同一份档位套用到本店全部订购表（§6.1 次按钮「套用商品级默认档位」）。
 *
 * 逐个商品重下发 metafield：档位按商品分片投递（§2.2.1），漏发任何一个都会让该商品
 * 在店面 / Function 侧停留在旧档位。
 */
export async function applyTiersToAllProducts(input: {
    admin: GraphqlAdmin;
    shop: string;
    tiersRaw: unknown;
}): Promise<number> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "tier_pricing")) throw new TablelyError("error.proRequired");

    const { model } = await getTierSettings(input.shop);
    const tiers = validateTierRows(input.tiersRaw, model);
    const payload = tiers as unknown as Prisma.InputJsonValue;

    const rows = await prisma.productTable.findMany({
        where: { shop: input.shop },
        select: { productId: true },
    });

    for (const row of rows) {
        await prisma.productTable.update({
            where: { shop_productId: { shop: input.shop, productId: row.productId } },
            data: { defaultTiers: payload },
        });
    }
    for (const row of rows) {
        await pushProductTableMetafield({
            admin: input.admin,
            shop: input.shop,
            productId: row.productId,
        });
    }

    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
    return rows.length;
}

/* ------------------------------ 批发价（B5） ------------------------------ */

export type WholesalePriceRow = { variantId: string; groupTag: string; price: string };

/**
 * 本店批发价行（可按商品过滤；`variantId` 为 GID，`price` 为十进制字符串，§16.4）。
 *
 * 为什么额外收 `variantIds`：`WholesalePrice` 不存 `productId`，无法从库内可靠地
 * 反查「某商品有哪些变体」（变体映射只在 Shopify 侧权威）。调用方（路由 loader）已按
 * `listProductVariants` 拿到商品变体集合，直接传入即可精确过滤；未传时退回全量。
 */
export async function listWholesalePrices(
    shop: string,
    productId?: string,
    variantIds?: string[],
): Promise<WholesalePriceRow[]> {
    const where: Prisma.WholesalePriceWhereInput = { shop };
    if (productId) {
        if (!variantIds || variantIds.length === 0) return [];
        where.variantId = { in: variantIds };
    }
    const rows = await prisma.wholesalePrice.findMany({
        where,
        orderBy: [{ groupTag: "asc" }, { variantId: "asc" }],
    });
    return rows.map((row) => ({
        variantId: row.variantId,
        groupTag: row.groupTag,
        price: row.price.toFixed(2),
    }));
}

/**
 * 保存某商品 × 某客户组的变体批发价（Pro，B5）。
 *
 * - `groupTag` 必须落在本店 `CustomerGroup`（否则 `error.notFound`，避免手打标签失联）；
 * - `price` 为空 → 删除该行；非空 → 校验十进制串后 upsert（唯一键 `shop_variantId_groupTag`）；
 * - 变体必须属于该商品（用 Admin API 变体列表做白名单，不信任前端）；
 * - 事务内完成整批增改删 → 重下发 product metafield → 刷新折扣。
 */
export async function saveVariantWholesalePrices(input: {
    admin: GraphqlAdmin;
    shop: string;
    productId: string;
    groupTag: string;
    prices: { variantId: string; price: string | null }[];
}): Promise<{ saved: number; deleted: number }> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "wholesale_price")) throw new TablelyError("error.proRequired");

    const groupTag = input.groupTag.trim();
    if (!groupTag) throw new TablelyError("error.notFound", "groupTag");
    const group = await prisma.customerGroup.findUnique({
        where: { shop_tag: { shop: input.shop, tag: groupTag } },
        select: { id: true },
    });
    if (!group) throw new TablelyError("error.notFound", "groupTag");

    const variants = await listProductVariants(input.admin, input.productId);
    const allowed = new Set(variants.map((variant) => variant.id));

    const toUpsert: { variantId: string; price: string }[] = [];
    const toDelete: string[] = [];
    const seen = new Set<string>();
    for (const entry of input.prices) {
        const variantId = (entry.variantId ?? "").trim();
        if (!variantId || !allowed.has(variantId) || seen.has(variantId)) continue;
        seen.add(variantId);
        const raw = (entry.price ?? "").trim();
        if (raw === "") {
            toDelete.push(variantId);
            continue;
        }
        if (!PRICE_RE.test(raw)) {
            throw new TablelyError("error.priceInvalid", `price-${gidToNumericId(variantId)}`);
        }
        toUpsert.push({ variantId, price: Number(raw).toFixed(2) });
    }

    await prisma.$transaction(async (tx) => {
        if (toDelete.length) {
            await tx.wholesalePrice.deleteMany({
                where: { shop: input.shop, groupTag, variantId: { in: toDelete } },
            });
        }
        for (const row of toUpsert) {
            await tx.wholesalePrice.upsert({
                where: {
                    shop_variantId_groupTag: {
                        shop: input.shop,
                        variantId: row.variantId,
                        groupTag,
                    },
                },
                update: { price: new Prisma.Decimal(row.price) },
                create: {
                    shop: input.shop,
                    variantId: row.variantId,
                    groupTag,
                    price: new Prisma.Decimal(row.price),
                },
            });
        }
    });

    await pushProductTableMetafield({
        admin: input.admin,
        shop: input.shop,
        productId: input.productId,
    });
    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
    return { saved: toUpsert.length, deleted: toDelete.length };
}

/* ------------------------------ Mix & Match ------------------------------ */

export type MixMatchGroupRecord = {
    id: string;
    name: string;
    tiers: TierEntry[];
    enabled: boolean;
    memberCount: number;
};

/** 混单组名称归一化（trim 必填 + 长度上限；`@@unique([shop, name])`） */
function normalizeMixName(raw: unknown): string {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) throw new TablelyError("error.mixNameRequired", "name");
    if (name.length > NAME_MAX) throw new TablelyError("error.mixNameTooLong", "name");
    return name;
}

/** 混单组列表（含各组成员数；`tiers` 已归一化） */
export async function listMixMatchGroups(shop: string): Promise<MixMatchGroupRecord[]> {
    const [groups, counts] = await Promise.all([
        prisma.mixMatchGroup.findMany({
            where: { shop },
            orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
        }),
        prisma.mixMatchMember.groupBy({
            by: ["groupId"],
            where: { shop },
            _count: { _all: true },
        }),
    ]);
    const countByGroup = new Map(counts.map((row) => [row.groupId, row._count._all]));
    return groups.map((group) => ({
        id: group.id,
        name: group.name,
        tiers: normalizeTiers(group.tiers),
        enabled: group.enabled,
        memberCount: countByGroup.get(group.id) ?? 0,
    }));
}

/** 新建混单组（Pro，§16.5）：名称查重 + 档位校验 → 刷新折扣 */
export async function createMixMatchGroup(input: {
    admin: GraphqlAdmin;
    shop: string;
    name: unknown;
    tiers: unknown;
    model: unknown;
}): Promise<MixMatchGroupRecord> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "mix_match")) throw new TablelyError("error.proRequired");

    const name = normalizeMixName(input.name);
    const tiers = validateTierRows(input.tiers, normalizeTierModel(input.model));

    const existing = await prisma.mixMatchGroup.findUnique({
        where: { shop_name: { shop: input.shop, name } },
        select: { id: true },
    });
    if (existing) throw new TablelyError("error.mixNameTaken", "name");

    const created = await prisma.mixMatchGroup.create({
        data: {
            shop: input.shop,
            name,
            tiers: tiers as unknown as Prisma.InputJsonValue,
        },
    });

    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
    return {
        id: created.id,
        name: created.name,
        tiers: normalizeTiers(created.tiers),
        enabled: created.enabled,
        memberCount: 0,
    };
}

/** 更新混单组（Pro）：改名需查重（排除自身）+ 档位校验 → 刷新折扣 */
export async function updateMixMatchGroup(input: {
    admin: GraphqlAdmin;
    shop: string;
    id: string;
    name: unknown;
    tiers: unknown;
    model: unknown;
}): Promise<MixMatchGroupRecord> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "mix_match")) throw new TablelyError("error.proRequired");

    const existing = await prisma.mixMatchGroup.findFirst({
        where: { id: input.id, shop: input.shop },
    });
    if (!existing) throw new TablelyError("error.notFound");

    const name = normalizeMixName(input.name);
    const tiers = validateTierRows(input.tiers, normalizeTierModel(input.model));

    if (name !== existing.name) {
        const clash = await prisma.mixMatchGroup.findUnique({
            where: { shop_name: { shop: input.shop, name } },
            select: { id: true },
        });
        if (clash && clash.id !== existing.id) {
            throw new TablelyError("error.mixNameTaken", "name");
        }
    }

    await prisma.mixMatchGroup.update({
        where: { id: existing.id },
        data: { name, tiers: tiers as unknown as Prisma.InputJsonValue },
    });

    const memberCount = await prisma.mixMatchMember.count({
        where: { shop: input.shop, groupId: existing.id },
    });
    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
    return {
        id: existing.id,
        name,
        tiers,
        enabled: existing.enabled,
        memberCount,
    };
}

/** 删除混单组（Pro）：同一事务先删成员再删组 → 刷新折扣 */
export async function deleteMixMatchGroup(input: {
    admin: GraphqlAdmin;
    shop: string;
    id: string;
}): Promise<void> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "mix_match")) throw new TablelyError("error.proRequired");

    const existing = await prisma.mixMatchGroup.findFirst({
        where: { id: input.id, shop: input.shop },
        select: { id: true },
    });
    if (!existing) throw new TablelyError("error.notFound");

    await prisma.$transaction(async (tx) => {
        await tx.mixMatchMember.deleteMany({
            where: { shop: input.shop, groupId: existing.id },
        });
        await tx.mixMatchGroup.delete({ where: { id: existing.id } });
    });

    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
}

/** 某混单组的成员变体（`variantId` 为 GID，`productId` 用于分组展示） */
export async function listMixMatchMembers(
    shop: string,
    groupId: string,
): Promise<{ variantId: string; productId: string }[]> {
    const rows = await prisma.mixMatchMember.findMany({
        where: { shop, groupId },
        orderBy: [{ productId: "asc" }, { variantId: "asc" }],
    });
    return rows.map((row) => ({ variantId: row.variantId, productId: row.productId }));
}

/**
 * 设置某混单组在某商品下的成员（Pro，§16.5「仅统计显式加入组的变体」）。
 *
 * 先删该组该商品下的全部成员，再按新集合 `createMany`（变体去重 + 白名单校验）；
 * 只动「该商品」的成员，不影响同组其它商品，最后刷新折扣。
 */
export async function setMixMatchMembers(input: {
    admin: GraphqlAdmin;
    shop: string;
    groupId: string;
    productId: string;
    variantIds: string[];
}): Promise<string[]> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "mix_match")) throw new TablelyError("error.proRequired");

    const group = await prisma.mixMatchGroup.findFirst({
        where: { id: input.groupId, shop: input.shop },
        select: { id: true },
    });
    if (!group) throw new TablelyError("error.notFound");

    const variants = await listProductVariants(input.admin, input.productId);
    const allowed = new Set(variants.map((variant) => variant.id));
    const ids = [
        ...new Set(
            input.variantIds
                .map((variantId) => (variantId ?? "").trim())
                .filter((variantId) => allowed.has(variantId)),
        ),
    ];

    await prisma.$transaction(async (tx) => {
        await tx.mixMatchMember.deleteMany({
            where: { shop: input.shop, groupId: input.groupId, productId: input.productId },
        });
        if (ids.length) {
            await tx.mixMatchMember.createMany({
                data: ids.map((variantId) => ({
                    shop: input.shop,
                    groupId: input.groupId,
                    variantId,
                    productId: input.productId,
                })),
            });
        }
    });

    await ensureDiscountsForShop({ admin: input.admin, shop: input.shop, plan });
    return ids;
}