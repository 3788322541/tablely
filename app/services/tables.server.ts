/**
 * 商品订购表读写（M3）
 *
 * 一个 ProductTable = 一个商品的订购表配置（`@@unique([shop, productId])`）；
 * 该商品下的每个变体最多一行 VariantRule（`@@unique([shop, variantId])`），
 * 承载 `min / max / step`（结构价 / 档位属 M12，M3 不写）。
 *
 * 保存链路（Tables → Drawer → 保存该商品）：
 *   服务端校验（起订金额 / min·max·step / Free 额度）→ 事务写 DB
 *   → 下发该商品的 app-owned metafield `tablely.table`（§2.7 契约 v2）
 *   → 返回成功；metafield 写失败必须**显式报错**，不允许静默成功（§六）。
 *
 * 硬约束：`shop` 一律由调用方从 `session` 传入（§8.2 A），本模块不自行解析请求。
 */

import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { MAX_TABLE_ROWS } from "../perf-limits";
import {
    buildProductTableValue,
    deleteProductTableMetafield,
    getShopInfo,
    normalizeLayout,
    pickColumnOverrides,
    syncProductTableMetafield,
    type GraphqlAdmin,
    type TableContractRow,
} from "./metafield.server";

/* ------------------------------- 错误 ------------------------------- */

/** 表单可回显的错误：key 是 i18n key（不是面向用户的成品文案），field 供表单定位 */
export class TablelyError extends Error {
    readonly key: string;
    readonly field: string | null;

    constructor(key: string, field: string | null = null) {
        super(key);
        this.name = "TablelyError";
        this.key = key;
        this.field = field;
    }
}

export function isTablelyError(error: unknown): error is TablelyError {
    return error instanceof TablelyError;
}

/* ------------------------------- 额度 ------------------------------- */

/** Free 档：可启用订购表的商品数（§1.4 #1，按「已启用订购表的商品数」计） */
export const FREE_PRODUCT_LIMIT = 3;

/** 该档位可启用的订购表数量上限（Pro 不限）。M9 起由 Billing 写入 PlanState，这里只读。 */
export function maxTablesForPlan(plan: string): number {
    return plan === "pro" ? Number.POSITIVE_INFINITY : FREE_PRODUCT_LIMIT;
}

/** 读取当前店铺档位（PlanState 由 M9 Billing 回写；无记录即 Free） */
export async function resolvePlan(shop: string): Promise<string> {
    const row = await prisma.planState.findUnique({
        where: { shop },
        select: { plan: true },
    });
    return row?.plan === "pro" ? "pro" : "free";
}

/* --------------------------- 值与规则校验 --------------------------- */

/** Decimal(10,2) 的边界：最多 8 位整数 + 2 位小数 */
const ORDER_MIN_RE = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * Y14 整单起订金额归一化（§16.6）。
 *
 * - **留空 = 不限**，必须返回 `null`（`0` 与「不限」语义完全不同，留空绝不写 0）；
 * - 只接受非负十进制、最多 2 位小数、不超过 `Decimal(10,2)` 上限；
 * - 金额全程用字符串（Decimal），禁止浮点。
 */
export function normalizeOrderMinAmount(
    raw: string | null | undefined,
): string | null {
    const text = (raw ?? "").trim();
    if (text === "") return null;
    if (!ORDER_MIN_RE.test(text)) throw new TablelyError("error.orderMinInvalid");
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) {
        throw new TablelyError("error.orderMinInvalid");
    }
    return value.toFixed(2);
}

/** 单变体数量规则的合法值（已解析为数字；`null` = 不限制） */
export type VariantRuleValues = {
    min: number;
    max: number | null;
    step: number;
};

/**
 * 校验一条变体规则。返回 i18n key（不合法）或 `null`（合法）。
 *
 * 抽成纯函数是为了单测与「批量套用」共用同一份规则，避免两套标准分叉。
 * `max = null` 表示不限；`min` / `step` 恒为 ≥ 1 的整数。
 */
export function validateVariantRule(rule: {
    min: number;
    max: number | null;
    step: number;
}): string | null {
    if (!Number.isInteger(rule.min) || rule.min < 1) return "error.ruleMinInvalid";
    if (!Number.isInteger(rule.step) || rule.step < 1) return "error.ruleStepInvalid";
    if (rule.max !== null) {
        if (!Number.isInteger(rule.max) || rule.max < rule.min) {
            return "error.ruleMaxInvalid";
        }
    }
    return null;
}

/** 解析正整数表单值；空串返回 `fallback`，非法抛错（key 由调用方指定） */
function parsePositiveInt(
    raw: string | null | undefined,
    fallback: number,
    errorKey: string,
): number {
    const text = (raw ?? "").trim();
    if (text === "") return fallback;
    if (!/^\d+$/.test(text)) throw new TablelyError(errorKey);
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value)) throw new TablelyError(errorKey);
    return value;
}

/** 解析可选正整数（`max`）：空串 = 不限（`null`） */
function parseOptionalInt(
    raw: string | null | undefined,
    errorKey: string,
): number | null {
    const text = (raw ?? "").trim();
    if (text === "") return null;
    if (!/^\d+$/.test(text)) throw new TablelyError(errorKey);
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value)) throw new TablelyError(errorKey);
    return value;
}

/* ----------------------------- GID 工具 ----------------------------- */

const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

/** `gid://shopify/ProductVariant/123` → `123`（Liquid / metafield 用纯数字） */
export function gidToNumericId(gid: string): string {
    const match = VARIANT_GID_RE.exec(gid.trim());
    return match ? match[1] : gid.trim();
}

/** 纯数字或 gid 都归一化成 gid；非法返回 `null` */
export function toVariantGid(raw: string): string | null {
    const value = raw.trim();
    if (!value) return null;
    if (/^\d+$/.test(value)) return `gid://shopify/ProductVariant/${value}`;
    return VARIANT_GID_RE.test(value) ? value : null;
}

/* --------------------------- 起订金额解析 --------------------------- */

/** 商品级覆写 → 店铺级默认 → 不限（§16.6 取值优先级） */
export function pickOrderMinAmount(
    productValue: string | null,
    shopValue: string | null,
): string | null {
    return productValue ?? shopValue ?? null;
}

/**
 * 读取生效的整单起订金额（十进制字符串 / `null` = 不限）。
 * 注意：店面实际判定用的是「折前小计」（§16.6），本函数只给阈值。
 */
export async function resolveOrderMinAmount(
    shop: string,
    productId?: string | null,
): Promise<string | null> {
    const [productRow, shopRow] = await Promise.all([
        productId
            ? prisma.productTable.findUnique({
                where: { shop_productId: { shop, productId } },
                select: { orderMinAmount: true },
            })
            : Promise.resolve(null),
        prisma.shopSettings.findUnique({
            where: { shop },
            select: { orderMinAmount: true },
        }),
    ]);

    const productValue = productRow?.orderMinAmount
        ? productRow.orderMinAmount.toFixed(2)
        : null;
    const shopValue = shopRow?.orderMinAmount
        ? shopRow.orderMinAmount.toFixed(2)
        : null;
    return pickOrderMinAmount(productValue, shopValue);
}

/* ------------------------------ 店铺级 ------------------------------ */

/** 店铺级默认起订金额（`null` = 不限）；无 ShopSettings 行时返回 null */
export async function getShopOrderMinAmount(
    shop: string,
): Promise<string | null> {
    const row = await prisma.shopSettings.findUnique({
        where: { shop },
        select: { orderMinAmount: true },
    });
    return row?.orderMinAmount ? row.orderMinAmount.toFixed(2) : null;
}

/** 保存店铺级默认起订金额（留空 → 落 `null`，不写 0） */
export async function saveShopOrderMinAmount(
    shop: string,
    raw: string | null | undefined,
): Promise<string | null> {
    const value = normalizeOrderMinAmount(raw);
    await prisma.shopSettings.upsert({
        where: { shop },
        update: { orderMinAmount: value },
        create: { shop, orderMinAmount: value },
    });
    return value;
}

/* ------------------------------- 读取 ------------------------------- */

export type ProductTableRecord = {
    productId: string;
    enabled: boolean;
    layout: string | null;
    columns: Record<string, boolean>;
    orderMinAmount: string | null;
    ruleCount: number;
    updatedAt: Date;
};

/** 按商品聚合变体规则条数（ProductTable 与 VariantRule 无 Prisma relation，故单独聚合） */
async function countRulesByProduct(
    shop: string,
    productIds: string[],
): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const groups = await prisma.variantRule.groupBy({
        by: ["productId"],
        where: { shop, productId: { in: productIds } },
        _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.productId, group._count._all]));
}

/**
 * 已配置订购表的商品列表（服务端分页，P5 每页 50 行）。
 *
 * `productIds` 用于「关键词搜索」路径：商品标题不在本应用库里（§四 未存 title），
 * 只能先用 Admin API 搜出命中的商品 id，再与库内已配置商品求交集。
 */
export async function listProductTables(input: {
    shop: string;
    take: number;
    skip: number;
    productIds?: string[];
}): Promise<{ items: ProductTableRecord[]; total: number }> {
    const where: Prisma.ProductTableWhereInput = { shop: input.shop };
    if (input.productIds) where.productId = { in: input.productIds };
    const [rows, total] = await Promise.all([
        prisma.productTable.findMany({
            where,
            orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
            take: input.take,
            skip: input.skip,
        }),
        prisma.productTable.count({ where }),
    ]);

    const ruleCounts = await countRulesByProduct(
        input.shop,
        rows.map((row) => row.productId),
    );

    return {
        items: rows.map((row) => ({
            productId: row.productId,
            enabled: row.enabled,
            layout: row.layout,
            columns: (row.columns ?? {}) as Record<string, boolean>,
            orderMinAmount: row.orderMinAmount
                ? row.orderMinAmount.toFixed(2)
                : null,
            ruleCount: ruleCounts.get(row.productId) ?? 0,
            updatedAt: row.updatedAt,
        })),
        total,
    };
}

/** 变体规则条数（单个商品） */
export async function countProductRules(
    shop: string,
    productId: string,
): Promise<number> {
    return prisma.variantRule.count({ where: { shop, productId } });
}

/** 已启用订购表的商品数（额度口径，§1.4 #1） */
export async function countEnabledTables(shop: string): Promise<number> {
    return prisma.productTable.count({ where: { shop, enabled: true } });
}

export type ProductTableDetail = {
    productId: string;
    enabled: boolean;
    layout: string | null;
    columns: Record<string, boolean>;
    orderMinAmount: string | null;
    rules: (VariantRuleValues & { variantId: string })[];
};

/** 某商品的订购表配置（含变体规则），未配置返回 null */
export async function getProductTable(
    shop: string,
    productId: string,
): Promise<ProductTableDetail | null> {
    const row = await prisma.productTable.findUnique({
        where: { shop_productId: { shop, productId } },
    });
    if (!row) return null;

    const ruleRows = await prisma.variantRule.findMany({
        where: { shop, productId },
        orderBy: { variantId: "asc" },
    });

    return {
        productId: row.productId,
        enabled: row.enabled,
        layout: row.layout,
        columns: (row.columns ?? {}) as Record<string, boolean>,
        orderMinAmount: row.orderMinAmount ? row.orderMinAmount.toFixed(2) : null,
        rules: ruleRows.map((rule) => ({
            variantId: rule.variantId,
            min: rule.min,
            max: rule.max,
            step: rule.step,
        })),
    };
}

/* ------------------------------- 写入 ------------------------------- */

export type ProductTableRuleInput = {
    /** 变体 gid（调用方负责把纯数字归一化） */
    variantId: string;
    min: string | null;
    max: string | null;
    step: string | null;
};

export type SaveProductTableInput = {
    /** 写 metafield 必须用 Admin API 客户端（服务端操作，不信任前端） */
    admin: GraphqlAdmin;
    shop: string;
    productId: string;
    enabled: boolean;
    /** 覆写布局；`null` = 继承全局 */
    layout: string | null;
    /** 原始表单值；留空 → 落 `null`（不写 0） */
    orderMinAmount: string | null | undefined;
    rules: ProductTableRuleInput[];
};

/**
 * 保存单个商品的订购表配置（事务写 DB + 下发 metafield）。
 *
 * - `rules` 为**整商品替换**语义：库里该商品原有的 VariantRule 全部删除后按传参重建；
 *   不属于该商品的变体 id 一律忽略（不信任前端）；
 * - Free 额度只在**新增启用**时拦截（已有数据不动，超限只读属 M9）；
 * - metafield 写失败抛 `error.metafieldFailed`：DB 已落库，商家重试保存即可补偿。
 */
export async function saveProductTable(
    input: SaveProductTableInput,
): Promise<void> {
    const orderMinAmount = normalizeOrderMinAmount(input.orderMinAmount);

    if (input.enabled) {
        const existing = await prisma.productTable.findUnique({
            where: { shop_productId: { shop: input.shop, productId: input.productId } },
            select: { enabled: true },
        });
        if (!existing?.enabled) {
            const plan = await resolvePlan(input.shop);
            const limit = maxTablesForPlan(plan);
            if (limit !== Number.POSITIVE_INFINITY) {
                const used = await countEnabledTables(input.shop);
                if (used >= limit) throw new TablelyError("error.limitProducts");
            }
        }
    }

    // 变体以 Admin API 为准（不信任表格里的展示数据），并顺带拿到 sku / title
    const variants = await listProductVariants(input.admin, input.productId);
    const variantIds = new Set(variants.map((variant) => variant.id));

    const rules: (VariantRuleValues & { variantId: string })[] = [];
    for (const raw of input.rules) {
        const variantId = toVariantGid(raw.variantId);
        if (!variantId || !variantIds.has(variantId)) continue;
        const values: VariantRuleValues = {
            min: parsePositiveInt(raw.min, 1, "error.ruleMinInvalid"),
            max: parseOptionalInt(raw.max, "error.ruleMaxInvalid"),
            step: parsePositiveInt(raw.step, 1, "error.ruleStepInvalid"),
        };
        const problem = validateVariantRule(values);
        if (problem) throw new TablelyError(problem, `min-${gidToNumericId(variantId)}`);
        rules.push({ variantId, ...values });
    }

    await prisma.$transaction(async (tx) => {
        await tx.productTable.upsert({
            where: { shop_productId: { shop: input.shop, productId: input.productId } },
            update: { enabled: input.enabled, layout: input.layout, orderMinAmount },
            create: {
                shop: input.shop,
                productId: input.productId,
                enabled: input.enabled,
                layout: input.layout,
                orderMinAmount,
            },
        });

        await tx.variantRule.deleteMany({
            where: { shop: input.shop, productId: input.productId },
        });
        if (rules.length) {
            await tx.variantRule.createMany({
                data: rules.map((rule) => ({
                    shop: input.shop,
                    productId: input.productId,
                    variantId: rule.variantId,
                    min: rule.min,
                    max: rule.max,
                    step: rule.step,
                })),
            });
        }
    });

    // 下发商品级 app-owned metafield（§2.7）。从 DB 现状重建，
    // 这样 `columns` 等未在本表单编辑的字段不会被本次保存清空（模板会把它们写进来）。
    await pushProductTableMetafield({
        admin: input.admin,
        shop: input.shop,
        productId: input.productId,
    });
}

/**
 * 由 DB 现状重建并下发商品级 metafield。
 *
 * 「读库 → 取变体 → 序列化」只有这一处，保存商品与套用模板共用，
 * 避免两处各拼一份 JSON 导致店面与后台分叉。失败必须显式报错（§六）。
 */
export async function pushProductTableMetafield(input: {
    admin: GraphqlAdmin;
    shop: string;
    productId: string;
}): Promise<void> {
    const table = await prisma.productTable.findUnique({
        where: { shop_productId: { shop: input.shop, productId: input.productId } },
    });
    if (!table) throw new TablelyError("error.notFound");

    const [variants, ruleRows] = await Promise.all([
        listProductVariants(input.admin, input.productId),
        prisma.variantRule.findMany({
            where: { shop: input.shop, productId: input.productId },
        }),
    ]);
    const ruleValues: (VariantRuleValues & { variantId: string })[] = ruleRows.map(
        (rule) => ({
            variantId: rule.variantId,
            min: rule.min,
            max: rule.max,
            step: rule.step,
        }),
    );

    try {
        await syncProductTableMetafield(
            input.admin,
            input.productId,
            buildProductTableValue({
                v: 2,
                enabled: table.enabled,
                layout: normalizeLayout(table.layout),
                columns: pickColumnOverrides(table.columns),
                orderMinAmount: table.orderMinAmount
                    ? table.orderMinAmount.toFixed(2)
                    : null,
                rows: buildContractRows(variants, ruleValues),
                // 矩阵坐标属 M6：M4 只保证契约字段存在且为 null，Liquid 走表格布局
                matrix: null,
            }),
        );
    } catch (error) {
        console.error("[tablely] 下发商品 metafield 失败:", error);
        throw new TablelyError("error.metafieldFailed");
    }
}

/** 变体（Admin API 权威）+ 规则 → metafield 的 `rows[]`（不含价格 / 库存） */
function buildContractRows(
    variants: { id: string; sku: string | null; title: string }[],
    rules: (VariantRuleValues & { variantId: string })[],
): TableContractRow[] {
    const byVariant = new Map(rules.map((rule) => [rule.variantId, rule] as const));
    return variants.map((variant) => {
        const rule = byVariant.get(variant.id);
        return {
            vid: gidToNumericId(variant.id),
            sku: variant.sku,
            title: variant.title,
            min: rule?.min ?? 1,
            max: rule?.max ?? null,
            step: rule?.step ?? 1,
            // 档位（B6 展开）属 M12、批发价（B5 多组）属 M10/M12；
            // M4 只保证「每行字段结构一致」（§五），故恒为空数组。
            tiers: [],
            wholesale: [],
        };
    });
}

/** 批量新增商品（「选择商品」→ 建立默认配置并启用）；超额度抛 error.limitProducts */
export async function addProductTables(input: {
    shop: string;
    productIds: string[];
}): Promise<number> {
    const unique = [...new Set(input.productIds.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) throw new TablelyError("error.saveFailed");

    const existing = await prisma.productTable.findMany({
        where: { shop: input.shop, productId: { in: unique } },
        select: { productId: true },
    });
    const existingIds = new Set(existing.map((row) => row.productId));
    const toCreate = unique.filter((id) => !existingIds.has(id));

    if (toCreate.length) {
        const plan = await resolvePlan(input.shop);
        const limit = maxTablesForPlan(plan);
        if (limit !== Number.POSITIVE_INFINITY) {
            const used = await countEnabledTables(input.shop);
            if (used + toCreate.length > limit) {
                throw new TablelyError("error.limitProducts");
            }
        }
        // B12：「设为默认」的布局模板由**新商品继承**（布局 / 列开关；规则不继承，
        // 因为模板里的变体 id 属于别的商品，套上去没有意义）。
        const defaultTemplate = await prisma.layoutTemplate.findFirst({
            where: { shop: input.shop, isDefault: true },
            select: { payload: true },
        });
        const payload = (defaultTemplate?.payload ?? {}) as {
            layout?: unknown;
            columns?: unknown;
        };
        const layout = typeof payload.layout === "string" ? payload.layout : null;
        const columns =
            payload.columns && typeof payload.columns === "object"
                ? (payload.columns as Prisma.InputJsonValue)
                : undefined;

        await prisma.productTable.createMany({
            data: toCreate.map((productId) => ({
                shop: input.shop,
                productId,
                enabled: true,
                layout,
                ...(columns ? { columns } : {}),
            })),
        });
    }

    return toCreate.length;
}

/** 只切换启用开关（不动规则与起订金额） */
export async function setProductTableEnabled(input: {
    shop: string;
    productId: string;
    enabled: boolean;
}): Promise<void> {
    const row = await prisma.productTable.findUnique({
        where: { shop_productId: { shop: input.shop, productId: input.productId } },
        select: { enabled: true },
    });
    if (!row) throw new TablelyError("error.notFound");

    if (input.enabled && !row.enabled) {
        const plan = await resolvePlan(input.shop);
        const limit = maxTablesForPlan(plan);
        if (limit !== Number.POSITIVE_INFINITY) {
            const used = await countEnabledTables(input.shop);
            if (used >= limit) throw new TablelyError("error.limitProducts");
        }
    }

    await prisma.productTable.update({
        where: { shop_productId: { shop: input.shop, productId: input.productId } },
        data: { enabled: input.enabled },
    });
}

/** 删除某商品的订购表配置（级联删规则）并清理 metafield */
export async function deleteProductTable(input: {
    admin: GraphqlAdmin;
    shop: string;
    productId: string;
}): Promise<void> {
    const row = await prisma.productTable.findUnique({
        where: { shop_productId: { shop: input.shop, productId: input.productId } },
        select: { id: true },
    });
    if (!row) throw new TablelyError("error.notFound");

    // ProductTable 与 VariantRule 之间没有 Prisma relation（无外键级联），
    // 必须在同一事务里显式清理变体规则，避免留下孤儿行。
    await prisma.$transaction([
        prisma.variantRule.deleteMany({
            where: { shop: input.shop, productId: input.productId },
        }),
        prisma.productTable.delete({ where: { id: row.id } }),
    ]);

    try {
        await deleteProductTableMetafield(input.admin, input.productId);
    } catch (error) {
        console.error("[tablely] 删除订购表后清理 metafield 失败:", error);
        throw new TablelyError("error.metafieldFailed");
    }
}

/* ---------------------------- Admin API ---------------------------- */

/** 后台与御用的 Admin API 客户端形状 */
export { type GraphqlAdmin };

/** 店铺本位币（起订金额字段的 suffix；§16.6 按店铺本位币存储与比较） */
export async function getShopCurrency(admin: GraphqlAdmin): Promise<string> {
    // 与 Shop 级 metafield 下发共用同一份店铺查询（getShopInfo 顺带取 shop.id）
    const info = await getShopInfo(admin);
    return info.currencyCode;
}

export type ShopifyProductRow = {
    id: string;
    title: string;
    handle: string;
    imageUrl: string | null;
    variantCount: number;
};

const PRODUCTS_QUERY = `#graphql
  query TablelyProducts($first: Int!, $query: String, $after: String) {
    products(first: $first, query: $query, after: $after, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        featuredImage {
          url
        }
        variantsCount {
          count
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PRODUCTS_BY_IDS_QUERY = `#graphql
  query TablelyProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        featuredImage {
          url
        }
        variantsCount {
          count
        }
      }
    }
  }
`;

type ProductNode = {
    id: string;
    title: string;
    handle: string;
    featuredImage?: { url?: string | null } | null;
    variantsCount?: { count?: number | null } | null;
};

function assertNoGraphqlErrors(json: unknown, context: string) {
    const errors = (json as { errors?: { message: string }[] })?.errors;
    if (Array.isArray(errors) && errors.length) {
        throw new Error(
            `[tablely] ${context}: ${errors.map((error) => error.message).join("; ")}`,
        );
    }
}

function toProductRow(node: ProductNode): ShopifyProductRow {
    return {
        id: node.id,
        title: node.title,
        handle: node.handle,
        imageUrl: node.featuredImage?.url ?? null,
        variantCount: node.variantsCount?.count ?? 0,
    };
}

/** 商品列表（Admin API 权威数据；keyword 走 Admin 搜索语法） */
export async function listProducts(
    admin: GraphqlAdmin,
    input: { query?: string; first?: number; after?: string | null } = {},
): Promise<{ items: ShopifyProductRow[]; hasNextPage: boolean; endCursor: string | null }> {
    const keyword = input.query?.trim();
    const res = await admin.graphql(PRODUCTS_QUERY, {
        variables: {
            first: input.first ?? 50,
            query: keyword ? keyword : null,
            after: input.after ?? null,
        },
    });
    const json = await res.json();
    assertNoGraphqlErrors(json, "listProducts");

    const products = (json as {
        data?: {
            products?: {
                nodes?: ProductNode[];
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            };
        };
    })?.data?.products;

    return {
        items: (products?.nodes ?? []).map(toProductRow),
        hasNextPage: Boolean(products?.pageInfo?.hasNextPage),
        endCursor: products?.pageInfo?.endCursor ?? null,
    };
}

/** 按 id 批量取商品（列表分页后补标题 / 图片；保持传入顺序由调用方负责） */
export async function getProductRefsByIds(
    admin: GraphqlAdmin,
    ids: string[],
): Promise<ShopifyProductRow[]> {
    if (ids.length === 0) return [];
    const res = await admin.graphql(PRODUCTS_BY_IDS_QUERY, { variables: { ids } });
    const json = await res.json();
    assertNoGraphqlErrors(json, "getProductRefsByIds");

    const nodes = (json as { data?: { nodes?: (ProductNode | null)[] } })?.data?.nodes ?? [];
    return nodes.filter((node): node is ProductNode => Boolean(node?.id)).map(toProductRow);
}

export type ShopifyVariantRow = {
    /** `gid://shopify/ProductVariant/…`（DB 存 gid；下发 metafield 时才转纯数字） */
    id: string;
    title: string;
    sku: string | null;
};

const PRODUCT_VARIANTS_QUERY = `#graphql
  query TablelyProductVariants($id: ID!, $first: Int!) {
    product(id: $id) {
      variants(first: $first) {
        nodes {
          id
          title
          sku
        }
      }
    }
  }
`;

/**
 * 商品的变体列表（Drawer 的规则表）。
 * 单次取前 100 个：与 P1「单商品订购表行数 ≤ 100」为同一上限。
 */
export async function listProductVariants(
    admin: GraphqlAdmin,
    productId: string,
    first = MAX_TABLE_ROWS,
): Promise<ShopifyVariantRow[]> {
    const res = await admin.graphql(PRODUCT_VARIANTS_QUERY, {
        variables: { id: productId, first },
    });
    const json = await res.json();
    assertNoGraphqlErrors(json, "listProductVariants");

    const nodes = (json as {
        data?: { product?: { variants?: { nodes?: { id: string; title?: string; sku?: string | null }[] } } };
    })?.data?.product?.variants?.nodes ?? [];

    return nodes.map((node) => ({
        id: node.id,
        title: node.title ?? "",
        sku: node.sku ?? null,
    }));
}