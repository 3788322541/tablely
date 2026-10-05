/**
 * 报价单生成与生命周期（M13 / Y17 / §15.8）—— **服务端专用**
 *
 * 核心边界（务必先读，避免后续误改）：
 *   · **调用 Admin API 实时取价**生成快照 —— **不读 metafield 里的价**（§2.7 A1 硬约定）；
 *   · `lines` 存**价格快照**与 A1 **不冲突** —— A1 禁止的是「用 metafield 当店面实时数据源」，
 *     报价单本质是**某一时刻的报价凭证**，必须冻结当时价格才有「有效期」可言（§15.8.4）；
 *   · **匿名** token 一律只展示**公开阶梯价**；**专属价只能通过登录态返回**（§15.8.2 红线）；
 *   · `token` = 32 字节随机 base64url，**不可顺序猜测**；可撤销 / 重生成（§15.8.4）。
 *
 * 专属价来源（零 PCD 约束下的实现口径）：应用**不申请任何 customers 权限**（§2.4），
 * 因此无法读取客户的 `tags` 去定位客户组。生成「客户专属报价」时，按**店铺已配置的
 * 批发价取每个变体的最低价**冻结进快照（与 §16.4 第 4 条「多组命中取最低价」同口径、
 * 结果确定可预期）；展示侧再用 `customerId` 与登录态做**身份匹配**，不匹配即降级为公开档位。
 */

import { randomBytes } from "node:crypto";

import prisma from "../db.server";
import { normalizeTiers, type GraphqlAdmin, type TierEntry } from "./metafield.server";
import { gidToNumericId } from "./tables.server";
import { QUOTE_PATH } from "./appProxy.server";

/** 报价单默认有效期（天）—— §15.8.3「默认 7 天，生成时可改」 */
export const QUOTE_DEFAULT_VALID_DAYS = 7;

/** 单张报价单行数护栏（避免一次选取过多商品撑爆一张报价单） */
export const QUOTE_MAX_LINES = 200;

/* ============================== 类型 ============================== */

/** 报价单行（冻结快照；金额一律为**整数分**，折前价） */
export type QuoteLine = {
    variantId: string;
    productId: string;
    sku: string;
    title: string;
    qty: number;
    /** 折前单价（整数分，生成时刻的 Admin API 实时价） */
    unitPrice: number;
    /** 公开阶梯档位（与店面表格同源） */
    tiers: TierEntry[];
    /** 客户专属批发价（整数分，冻结）；**仅登录且身份匹配时展示** */
    wholesale?: number;
};

export type QuoteRecord = {
    id: string;
    /** 店铺域名（报价单页眉的店铺标识） */
    shop: string;
    token: string;
    title: string | null;
    note: string | null;
    currency: string;
    validUntil: Date;
    customerId: string | null;
    lines: QuoteLine[];
    revoked: boolean;
    createdAt: Date;
};

/* ============================== 纯函数（可单测） ============================== */

/** 32 字节随机 → base64url（URL 安全、不可猜测） */
export function generateQuoteToken(): string {
    return randomBytes(32).toString("base64url");
}

/** 有效期天数合法化：默认 7 天，允许 1–90 天（防误填成 0 / 负数 / 超大） */
export function normalizeValidDays(value: unknown): number {
    const num = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(num) || num < 1) return QUOTE_DEFAULT_VALID_DAYS;
    return Math.min(90, Math.floor(num));
}

/** 失效时间 = 生成时刻 + N 天 */
export function computeValidUntil(createdAt: Date, validDays: number): Date {
    return new Date(createdAt.getTime() + validDays * 24 * 60 * 60 * 1000);
}

/** 报价单是否可访问：未撤销且未过期 */
export function isQuoteActive(
    quote: { revoked: boolean; validUntil: Date },
    now: Date = new Date(),
): boolean {
    return !quote.revoked && quote.validUntil.getTime() > now.getTime();
}

/**
 * **展示专属价的条件**（§15.8.2 红线）——只有「本报价单挂了目标客户」且
 * 「当前登录客户 id 与之完全一致」时才是 true；其余一切情况（匿名 / 未登录 / 不匹配）
 * 一律 false → 页面只渲染公开档位，不报错也不泄露。
 */
export function canViewWholesale(
    quote: { customerId: string | null },
    loggedInCustomerId: string | null,
): boolean {
    return Boolean(quote.customerId) && quote.customerId === loggedInCustomerId;
}

/** 客户可见地址：店铺同域 `https://<shop>/apps/tablely/quote/<token>`（§十 路由表） */
export function buildQuotePublicUrl(shop: string, token: string): string {
    return `https://${shop}${QUOTE_PATH}/${token}`;
}

/** 展示用报价单号：token 前 8 位大写（避免暴露完整 token） */
export function quoteNumber(token: string): string {
    return token.slice(0, 8).toUpperCase();
}

/* ============================== Admin API：实时取价 ============================== */

const QUOTE_SOURCE_QUERY = `#graphql
  query TablelyQuoteSource($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        variants(first: 100) {
          nodes {
            id
            sku
            title
            price
            product {
              id
              title
            }
          }
        }
      }
    }
  }
`;

type SourceVariant = {
    variantId: string;
    productId: string;
    sku: string;
    title: string;
    unitPrice: number;
};

/** 从选中的商品里取变体（实时价 / SKU / 标题） */
async function fetchSourceVariants(
    admin: GraphqlAdmin,
    productGids: string[],
): Promise<SourceVariant[]> {
    if (productGids.length === 0) return [];
    const res = await admin.graphql(QUOTE_SOURCE_QUERY, { variables: { ids: productGids } });
    const json = (await res.json()) as {
        data?: {
            nodes?: ({
                id?: string;
                title?: string;
                variants?: {
                    nodes?: ({
                        id?: string;
                        sku?: string | null;
                        title?: string | null;
                        price?: string | null;
                    } | null)[];
                };
            } | null)[];
        };
    };

    const rows: SourceVariant[] = [];
    for (const node of json?.data?.nodes ?? []) {
        if (!node?.id) continue;
        for (const variant of node.variants?.nodes ?? []) {
            if (!variant?.id) continue;
            const productTitle = node.title ?? "";
            const variantTitle = variant.title ?? "";
            const title =
                variantTitle && variantTitle !== "Default Title"
                    ? `${productTitle} — ${variantTitle}`
                    : productTitle || variant.sku || "";
            rows.push({
                variantId: gidToNumericId(variant.id),
                productId: gidToNumericId(node.id),
                sku: variant.sku ?? "",
                title,
                unitPrice: Math.round((Number.parseFloat(variant.price ?? "0") || 0) * 100),
            });
        }
    }
    return rows;
}

/** 变体生效的公开阶梯档位：变体自带优先，否则继承商品级默认（与补货页同序） */
async function loadTiers(
    shop: string,
    variantGids: string[],
    productGids: string[],
): Promise<Map<string, TierEntry[]>> {
    const [rules, tables] = await Promise.all([
        prisma.variantRule.findMany({
            where: { shop, variantId: { in: variantGids } },
            select: { variantId: true, tiers: true },
        }),
        prisma.productTable.findMany({
            where: { shop, productId: { in: productGids } },
            select: { productId: true, defaultTiers: true },
        }),
    ]);
    const ownByGid = new Map(rules.map((rule) => [rule.variantId, normalizeTiers(rule.tiers)]));
    const defaultByProduct = new Map(
        tables.map((table) => [table.productId, normalizeTiers(table.defaultTiers)]),
    );
    const result = new Map<string, TierEntry[]>();
    for (const gid of variantGids) {
        const own = ownByGid.get(gid) ?? [];
        const productGid = `gid://shopify/Product/${gidToNumericId(gid)}`;
        result.set(gid, own.length ? own : defaultByProduct.get(productGid) ?? []);
    }
    return result;
}

/** 每个变体的最低批发价（店铺已配置的 WholesalePrice 取最小；无配置 → 不产出） */
async function loadLowestWholesale(
    shop: string,
    variantGids: string[],
): Promise<Map<string, number>> {
    const prices = await prisma.wholesalePrice.findMany({
        where: { shop, variantId: { in: variantGids } },
        select: { variantId: true, price: true },
    });
    const map = new Map<string, number>();
    for (const row of prices) {
        // Decimal → 整数分（四舍五入到分，避免浮点）
        const cents = Math.round(Number(row.price.toString()) * 100);
        if (!Number.isFinite(cents) || cents < 0) continue;
        const current = map.get(row.variantId);
        if (current === undefined || cents < current) map.set(row.variantId, cents);
    }
    return map;
}

/** 变体级下单下限（默认数量用；无规则 → 1） */
async function loadMinQuantities(
    shop: string,
    variantGids: string[],
): Promise<Map<string, number>> {
    const rules = await prisma.variantRule.findMany({
        where: { shop, variantId: { in: variantGids } },
        select: { variantId: true, min: true },
    });
    const map = new Map<string, number>();
    for (const rule of rules) {
        const min = Number.isInteger(rule.min) && rule.min > 0 ? rule.min : 1;
        map.set(rule.variantId, min);
    }
    return map;
}

/* ============================== 生成 ============================== */

export type CreatedQuote = { id: string; token: string; validUntil: Date };

/**
 * 由**选中商品**生成报价单：实时取价 → 冻结快照 → 签发 token。
 * 无任何行（商品无变体 / 取不到）→ 返回 null（调用方提示 `quote.selectProducts`）。
 */
export async function createQuote(input: {
    shop: string;
    admin: GraphqlAdmin;
    productIds: string[];
    currency: string;
    note?: string | null;
    validDays?: unknown;
    customerId?: string | null;
    title?: string | null;
}): Promise<CreatedQuote | null> {
    // 只接受纯数字商品 id（与 DB / metafield 口径一致），单次最多 50 个商品
    const productGids = [...new Set(input.productIds)]
        .filter((id) => /^\d+$/.test(id))
        .slice(0, 50)
        .map((id) => `gid://shopify/Product/${id}`);

    const variants = (await fetchSourceVariants(input.admin, productGids)).slice(
        0,
        QUOTE_MAX_LINES,
    );
    if (variants.length === 0) return null;

    const variantGids = variants.map((row) => `gid://shopify/ProductVariant/${row.variantId}`);
    const [tiersByGid, wholesaleByGid, minByGid] = await Promise.all([
        loadTiers(input.shop, variantGids, productGids),
        loadLowestWholesale(input.shop, variantGids),
        loadMinQuantities(input.shop, variantGids),
    ]);

    const lines: QuoteLine[] = variants.map((row) => {
        const gid = `gid://shopify/ProductVariant/${row.variantId}`;
        const wholesale = wholesaleByGid.get(gid);
        return {
            variantId: row.variantId,
            productId: row.productId,
            sku: row.sku,
            title: row.title,
            qty: minByGid.get(gid) ?? 1,
            unitPrice: row.unitPrice,
            tiers: tiersByGid.get(gid) ?? [],
            ...(wholesale !== undefined ? { wholesale } : {}),
        };
    });

    const customerId =
        typeof input.customerId === "string" && /^\d+$/.test(input.customerId.trim())
            ? input.customerId.trim()
            : null;

    const createdAt = new Date();
    const validUntil = computeValidUntil(createdAt, normalizeValidDays(input.validDays));
    const token = generateQuoteToken();

    const created = await prisma.quote.create({
        data: {
            shop: input.shop,
            token,
            title: input.title?.trim() ? input.title.trim() : null,
            note: input.note?.trim() ? input.note.trim() : null,
            currency: input.currency,
            validUntil,
            customerId,
            lines,
            revoked: false,
        },
        select: { id: true, token: true, validUntil: true },
    });

    return created;
}

/* ============================== 读取 / 生命周期 ============================== */

export async function getQuoteByToken(
    shop: string,
    token: string,
): Promise<QuoteRecord | null> {
    if (!token) return null;
    const quote = await prisma.quote.findFirst({ where: { shop, token } });
    if (!quote) return null;
    return {
        id: quote.id,
        shop: quote.shop,
        token: quote.token,
        title: quote.title,
        note: quote.note,
        currency: quote.currency,
        validUntil: quote.validUntil,
        customerId: quote.customerId,
        lines: Array.isArray(quote.lines) ? (quote.lines as unknown as QuoteLine[]) : [],
        revoked: quote.revoked,
        createdAt: quote.createdAt,
    };
}

/** 撤销：旧链接立即失效（§15.8.4） */
export async function revokeQuote(shop: string, token: string): Promise<boolean> {
    const result = await prisma.quote.updateMany({
        where: { shop, token },
        data: { revoked: true },
    });
    return result.count > 0;
}

/** 重新生成 token：返回新 token（旧链接立即失效，且自动解除撤销态） */
export async function regenerateQuoteToken(
    shop: string,
    token: string,
): Promise<string | null> {
    const next = generateQuoteToken();
    const result = await prisma.quote.updateMany({
        where: { shop, token },
        data: { token: next, revoked: false },
    });
    return result.count > 0 ? next : null;
}

/**
 * `customers/redact`：把该客户的报价单 `customerId` **置 null 并保留整行**
 * （报价单是商家的商业记账凭据，脱敏即可，不必整条删除，§15.8.4 / §8.1）。
 */
export async function nullifyQuotesForCustomer(input: {
    shop: string;
    customerId: string | null;
}): Promise<number> {
    if (!input.customerId) return 0;
    const result = await prisma.quote.updateMany({
        where: { shop: input.shop, customerId: input.customerId },
        data: { customerId: null },
    });
    return result.count;
}