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

import prisma from "../db.server";
import { hasFeature } from "../plan";
import { GATE_MODES, type GraphqlAdmin } from "./metafield.server";
import { ensureShopSettings, pushShopSettingsMetafield } from "./settings.server";
import { resolvePlan, TablelyError } from "./tables.server";

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