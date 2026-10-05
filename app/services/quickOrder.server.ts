/**
 * 快速补货落脚页的数据组装（M13 / §15.4）—— **服务端专用**
 *
 * 三条输入路径（粘贴 SKU 清单 / 上传 CSV / 历史加购）最终都归一到同一份
 * `RequestedLine[]`，再经 `resolveQuickOrder` 变成可直接渲染 + 加购的 `QuickOrderLine[]`。
 *
 * 硬约束：
 *   · **P8 上限**：清单 ≤ `QUICK_ORDER_MAX_LINES`（50）行，超出的行**明确提示**而非静默丢弃；
 *   · **未匹配 SKU 明确列出**（§15.4），不静默丢弃；
 *   · **数量合法化**：按 `min / max / step` 吸附后再 clamp（§15.7 第 1 条），
 *     绝不把会导致提交失败的数值填进表单；
 *   · SKU 匹配走 Admin API（权威数据），规则 / 档位 / 混单组走本应用 DB；
 *   · 混单提示（`mixmatch.hint`）**跨商品聚合组内总量**，取最近的下一档（§20.1）。
 */

import prisma from "../db.server";
import { QUICK_ORDER_MAX_LINES } from "../perf-limits";
import {
    parseCsv,
    type CsvDataRow,
} from "./csv.server";
import { normalizeTiers, type GraphqlAdmin, type TierEntry } from "./metafield.server";
import { gidToNumericId } from "./tables.server";

/* ============================== 类型 ============================== */

/** 归一化后的「请求行」：`quantity = null` 表示未指定（合法化时取该变体的最小合法数量） */
export type RequestedLine = { sku: string; quantity: number | null };

/** 可渲染 / 可加购的一行 */
export type QuickOrderLine = {
    /** 纯数字变体 id（与店面 `/cart/add`、`api.addtocart` 口径一致） */
    variantId: string;
    /** 纯数字商品 id */
    productId: string;
    sku: string;
    productTitle: string;
    variantTitle: string;
    /** 折前单价（整数分） */
    priceCents: number;
    availableForSale: boolean;
    min: number;
    max: number | null;
    step: number;
    quantity: number;
    /** 该变体生效的阶梯档位（自带优先，否则继承商品级默认） */
    tiers: TierEntry[];
};

export type QuickOrderResult = {
    lines: QuickOrderLine[];
    /** 未能匹配到变体的 SKU（原样列出） */
    unmatched: string[];
    /** 输入行数超过 P8 上限（已截断到上限） */
    overLimit: boolean;
    /** 混单提示：再加 `n` 件享 `percent`% 折扣（无命中为 null） */
    mixHint: { n: number; percent: number } | null;
};

/** 历史加购返回的行（`variantId` 为纯数字串） */
export type HistoryRequestLine = { variantId: string; quantity: number };

/* ============================== 解析（纯函数，可单测） ============================== */

/**
 * 截断到 P8 上限：返回保留下来的行与「是否发生截断」。
 * 截断必须让调用方向顾客明示（`quickOrder.lineLimit`），不静默丢弃。
 */
export function truncateToLimit<T>(
    rows: T[],
    limit: number = QUICK_ORDER_MAX_LINES,
): { rows: T[]; overLimit: boolean } {
    if (rows.length <= limit) return { rows, overLimit: false };
    return { rows: rows.slice(0, limit), overLimit: true };
}

/** 正整数解析：空 → null；`"12"` → 12；其余 → undefined（非法） */
function parseQtyCell(raw: string | undefined): number | null | undefined {
    const text = (raw ?? "").trim();
    if (text === "") return null;
    if (!/^\d+$/.test(text)) return undefined;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 1) return undefined;
    return value;
}

/**
 * 粘贴清单解析：每行 `SKU,数量`。
 * 只有 SKU（无逗号）视为「数量未指定」；数量列非法记为该行错误（`quickOrder.invalidSku`）。
 */
export function parsePasteList(text: string): {
    rows: RequestedLine[];
    invalid: string[];
} {
    const rows: RequestedLine[] = [];
    const invalid: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "") continue;
        const comma = line.indexOf(",");
        const sku = (comma === -1 ? line : line.slice(0, comma)).trim();
        const qtyRaw = comma === -1 ? "" : line.slice(comma + 1);
        if (sku === "") {
            invalid.push(line);
            continue;
        }
        const quantity = parseQtyCell(qtyRaw);
        if (quantity === undefined) {
            invalid.push(line);
            continue;
        }
        rows.push({ sku, quantity });
    }
    return { rows, invalid };
}

/**
 * CSV 清单解析：列按**列名**定位（不强制整份模板列头，但必须有 `sku` 列）。
 * 缺 `sku` 列整体报错（`csv.err.headerMismatch`）；逐行失败不整单失败（§15.4）。
 */
export function parseCsvList(csvText: string): {
    rows: RequestedLine[];
    invalid: (CsvDataRow & { line: number })[];
    error: string | null;
} {
    const matrix = parseCsv(csvText);
    if (matrix.length === 0) return { rows: [], invalid: [], error: "csv.empty" };
    const header = matrix[0].map((cell) => cell.trim().toLowerCase());
    const skuIndex = header.indexOf("sku");
    if (skuIndex === -1) {
        return { rows: [], invalid: [], error: "csv.err.headerMismatch" };
    }
    const qtyIndex = header.indexOf("quantity");

    const rows: RequestedLine[] = [];
    const invalid: (CsvDataRow & { line: number })[] = [];
    for (let i = 1; i < matrix.length; i += 1) {
        const cells = matrix[i];
        const sku = (cells[skuIndex] ?? "").trim();
        const qtyRaw = qtyIndex === -1 ? "" : cells[qtyIndex];
        // 整行皆空：跳过（Excel 常见尾随空行）
        if (sku === "" && (qtyRaw ?? "").trim() === "") continue;
        const raw: CsvDataRow = { sku, quantity: (qtyRaw ?? "").trim() };
        if (sku === "") {
            invalid.push({ ...raw, line: i + 1 });
            continue;
        }
        const quantity = parseQtyCell(qtyRaw);
        if (quantity === undefined) {
            invalid.push({ ...raw, line: i + 1 });
            continue;
        }
        rows.push({ sku, quantity });
    }
    return { rows, invalid, error: null };
}

/* ============================== 数量合法化（纯函数，可单测） ============================== */

/**
 * 把顾客给出的数量合法化为「一定能提交」的值（§15.7）：
 * 先吸附到 `step` 的整数倍，再 clamp 到 `min / max`（吸附后再 clamp，避免越界）。
 */
export function legalizeQuantity(
    requested: number | null,
    min: number,
    max: number | null,
    step: number,
): number {
    const safeStep = Number.isInteger(step) && step > 1 ? step : 1;
    const safeMin = Number.isInteger(min) && min > 0 ? min : 1;
    const base = requested === null || !Number.isFinite(requested) || requested < 1
        ? safeMin
        : Math.round(requested);
    let qty = Math.ceil(base / safeStep) * safeStep;
    qty = Math.max(safeMin, qty);
    if (max !== null && Number.isFinite(max)) qty = Math.min(qty, Math.max(safeMin, max));
    return qty;
}

/* ============================== Admin API：SKU 匹配 ============================== */

const VARIANTS_BY_SKU_QUERY = `#graphql
  query TablelyVariantsBySku($query: String!, $first: Int!) {
    productVariants(first: $first, query: $query) {
      nodes {
        id
        sku
        title
        price
        availableForSale
        product {
          id
          title
        }
      }
    }
  }
`;

/** Shopify 搜索语法里对值做引号包裹（含空格 / 特殊字符时必须引号） */
function skuTerm(sku: string): string {
    if (/^[A-Za-z0-9_.-]+$/.test(sku)) return `sku:${sku}`;
    return `sku:"${sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export type MatchedVariant = {
    variantGid: string;
    sku: string;
    variantTitle: string;
    productGid: string;
    productTitle: string;
    priceCents: number;
    availableForSale: boolean;
};

/** 按 SKU 匹配变体（Admin API 权威）。返回 `sku → 变体` 映射（首个命中者生效）。 */
export async function matchVariantsBySku(
    admin: GraphqlAdmin,
    skus: string[],
): Promise<Map<string, MatchedVariant>> {
    const result = new Map<string, MatchedVariant>();
    const unique = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
    const CHUNK = 25;
    for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        const query = chunk.map(skuTerm).join(" OR ");
        const res = await admin.graphql(VARIANTS_BY_SKU_QUERY, {
            variables: { query, first: Math.max(QUICK_ORDER_MAX_LINES, chunk.length * 2) },
        });
        const json = await res.json();
        const nodes = (json as {
            data?: {
                productVariants?: {
                    nodes?: ({
                        id?: string;
                        sku?: string | null;
                        title?: string | null;
                        price?: string | null;
                        availableForSale?: boolean | null;
                        product?: { id?: string; title?: string | null } | null;
                    } | null)[];
                };
            };
        })?.data?.productVariants?.nodes ?? [];
        for (const node of nodes) {
            if (!node?.id || !node.sku) continue;
            const sku = node.sku;
            if (!chunk.includes(sku) || result.has(sku)) continue;
            result.set(sku, {
                variantGid: node.id,
                sku,
                variantTitle: node.title ?? "",
                productGid: node.product?.id ?? "",
                productTitle: node.product?.title ?? "",
                priceCents: Math.round((Number.parseFloat(node.price ?? "0") || 0) * 100),
                availableForSale: node.availableForSale !== false,
            });
        }
    }
    return result;
}

/* ============================== DB：规则 / 档位 / 混单 ============================== */

/**
 * 混单提示：跨商品聚合「组内变体在本次清单里的总量」，取**最近的下一档**（percent 模型）。
 * 无组 / 已达标 / 只有 price 模型 → null（无法用「再买 N 件享 X%」表达）。
 */
async function buildMixMatchHint(
    shop: string,
    lines: QuickOrderLine[],
): Promise<{ n: number; percent: number } | null> {
    if (lines.length === 0) return null;
    const gids = lines.map((line) => `gid://shopify/ProductVariant/${line.variantId}`);
    const members = await prisma.mixMatchMember.findMany({
        where: { shop, variantId: { in: gids } },
        select: { groupId: true, variantId: true },
    });
    if (members.length === 0) return null;

    const groups = await prisma.mixMatchGroup.findMany({
        where: { shop, enabled: true, id: { in: [...new Set(members.map((m) => m.groupId))] } },
        select: { id: true, tiers: true },
    });

    const qtyByGid = new Map(
        lines.map((line) => [`gid://shopify/ProductVariant/${line.variantId}`, line.quantity]),
    );

    let best: { n: number; percent: number } | null = null;
    for (const group of groups) {
        const memberGids = members
            .filter((member) => member.groupId === group.id)
            .map((member) => member.variantId);
        const total = memberGids.reduce((sum, gid) => sum + (qtyByGid.get(gid) ?? 0), 0);
        if (total <= 0) continue;
        for (const tier of normalizeTiers(group.tiers)) {
            if (tier.percent === undefined || tier.qty <= total) continue;
            const n = tier.qty - total;
            if (!best || n < best.n) best = { n, percent: tier.percent };
        }
    }
    return best;
}

/* ============================== 组装 ============================== */

/** 已匹配到变体的请求行 */
type HitRow = { quantity: number | null; hit: MatchedVariant };

type Assembled = {
    lines: QuickOrderLine[];
    mixHint: { n: number; percent: number } | null;
};

/** 由「已匹配的命中行」组装：附规则 / 档位、合法化数量、算混单提示（保持输入顺序） */
async function assembleLines(shop: string, hits: HitRow[]): Promise<Assembled> {
    const variantGids = hits.map((row) => row.hit.variantGid);
    const productGids = [
        ...new Set(hits.map((row) => row.hit.productGid).filter(Boolean)),
    ];
    const [rules, tables] = await Promise.all([
        prisma.variantRule.findMany({
            where: { shop, variantId: { in: variantGids } },
        }),
        prisma.productTable.findMany({
            where: { shop, productId: { in: productGids } },
            select: { productId: true, defaultTiers: true },
        }),
    ]);
    const ruleByGid = new Map(rules.map((rule) => [rule.variantId, rule]));
    const defaultTiersByProduct = new Map(
        tables.map((table) => [table.productId, normalizeTiers(table.defaultTiers)]),
    );

    const lines: QuickOrderLine[] = hits.map(({ quantity, hit }) => {
        const rule = ruleByGid.get(hit.variantGid);
        const own = normalizeTiers(rule?.tiers);
        const tiers = own.length ? own : defaultTiersByProduct.get(hit.productGid) ?? [];
        const min = rule?.min ?? 1;
        const max = rule?.max ?? null;
        const step = rule?.step ?? 1;
        return {
            variantId: gidToNumericId(hit.variantGid),
            productId: gidToNumericId(hit.productGid),
            sku: hit.sku,
            productTitle: hit.productTitle,
            variantTitle: hit.variantTitle,
            priceCents: hit.priceCents,
            availableForSale: hit.availableForSale,
            min,
            max,
            step,
            quantity: legalizeQuantity(quantity, min, max, step),
            tiers,
        };
    });

    return { lines, mixHint: await buildMixMatchHint(shop, lines) };
}

/**
 * 由「请求行」组装可渲染的补货清单（粘贴 / CSV 路径）。
 *
 * 顺序保持顾客输入顺序；重复 SKU 只保留首行；未匹配 SKU 汇总在 `unmatched`。
 */
export async function resolveQuickOrder(input: {
    admin: GraphqlAdmin;
    shop: string;
    requested: RequestedLine[];
}): Promise<QuickOrderResult> {
    const deduped: RequestedLine[] = [];
    const seen = new Set<string>();
    for (const row of input.requested) {
        const key = row.sku.trim();
        if (key === "" || seen.has(key)) continue;
        seen.add(key);
        deduped.push({ sku: key, quantity: row.quantity });
    }

    const matched = await matchVariantsBySku(
        input.admin,
        deduped.map((row) => row.sku),
    );

    const unmatched: string[] = [];
    const hits: HitRow[] = [];
    for (const row of deduped) {
        const hit = matched.get(row.sku);
        if (!hit) {
            unmatched.push(row.sku);
            continue;
        }
        hits.push({ quantity: row.quantity, hit });
    }

    const { lines, mixHint } = await assembleLines(input.shop, hits);
    return { lines, unmatched, overLimit: false, mixHint };
}

/** 历史加购路径：按变体 id 直接取详情后组装 */
export async function resolveHistoryQuickOrder(input: {
    admin: GraphqlAdmin;
    shop: string;
    history: HistoryRequestLine[];
}): Promise<QuickOrderResult> {
    const gids = input.history.map(
        (line) => `gid://shopify/ProductVariant/${line.variantId}`,
    );
    const refs = await fetchVariantDetails(input.admin, gids);
    const unmatched: string[] = [];
    const hits: HitRow[] = [];
    for (const line of input.history) {
        const hit = refs.get(`gid://shopify/ProductVariant/${line.variantId}`);
        if (!hit) {
            unmatched.push(line.variantId);
            continue;
        }
        hits.push({ quantity: line.quantity, hit });
    }
    const { lines, mixHint } = await assembleLines(input.shop, hits);
    return { lines, unmatched, overLimit: false, mixHint };
}

const VARIANTS_BY_IDS_QUERY = `#graphql
  query TablelyQuickOrderVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        sku
        title
        price
        availableForSale
        product {
          id
          title
        }
      }
    }
  }
`;

/** 按变体 id 批量取详情（历史路径；分块避免单次 query 过长） */
async function fetchVariantDetails(
    admin: GraphqlAdmin,
    ids: string[],
): Promise<Map<string, MatchedVariant>> {
    const map = new Map<string, MatchedVariant>();
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const res = await admin.graphql(VARIANTS_BY_IDS_QUERY, {
            variables: { ids: ids.slice(i, i + CHUNK) },
        });
        const json = await res.json();
        const nodes = (json as {
            data?: {
                nodes?: ({
                    id?: string;
                    sku?: string | null;
                    title?: string | null;
                    price?: string | null;
                    availableForSale?: boolean | null;
                    product?: { id?: string; title?: string | null } | null;
                } | null)[];
            };
        })?.data?.nodes ?? [];
        for (const node of nodes) {
            if (!node?.id) continue;
            map.set(node.id, {
                variantGid: node.id,
                sku: node.sku ?? "",
                variantTitle: node.title ?? "",
                productGid: node.product?.id ?? "",
                productTitle: node.product?.title ?? "",
                priceCents: Math.round((Number.parseFloat(node.price ?? "0") || 0) * 100),
                availableForSale: node.availableForSale !== false,
            });
        }
    }
    return map;
}