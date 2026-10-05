/**
 * CSV 导入（M13 / Y16 / §15.5–15.6）—— **服务端专用**
 *
 * 职责：把一份（模板格式的）CSV 文本变成「变体规则 + 商品级起订金额」的批量写入。
 * 与 `csv.server.ts`（纯字符串 ⇄ 行 + 格式校验）分工：本模块负责**变体匹配（Admin API）**
 * 与**逐行业务校验 / 落库 / 下发 metafield**。
 *
 * 硬约束（违反即事故）：
 *   · **先限流（P6：≤1000 行 / ≤1 MB）再解析写库**，超限整体拒绝、绝不部分写入（§十二 验收 24/33）；
 *   · **列头不匹配直接整体报错**，不做静默错列（§15.6，列头真源只有 `csv.server.ts` 一处）；
 *   · **逐行回报**：成功 N 行 / 失败 M 行 + 每行原因（`{line, sku, error}`），
 *     失败行**不写库**，成功行照写（CSV 的语义是「按行独立」）；
 *   · **`order_min_amount` 冲突**：同一商品多行给出不一致的非空值 → 该商品**所有行一并报错**
 *     （避免静默取其一，§15.5）；
 *   · 导入**以 SKU 为准匹配**变体，匹配不到该行报错（`variant_id` 列导入时忽略）。
 *
 * 隐私：错误清单只含 SKU 与原因，**不含顾客 PII**（§8.2 D）。
 */

import { randomBytes } from "node:crypto";

import prisma from "../db.server";
import { checkCsvLimits } from "../perf-limits";
import {
    csvHeaderError,
    parseAmountCell,
    parseCsv,
    parsePositiveIntCell,
    parsePercentCell,
    rowsFromMatrix,
    splitListCell,
    type CsvDataRow,
} from "./csv.server";
import { normalizeTiers, type GraphqlAdmin, type TierEntry } from "./metafield.server";
import { logStructured } from "./monitor.server";
import {
    gidToNumericId,
    normalizeOrderMinAmount,
    pushProductTableMetafield,
    TablelyError,
    validateVariantRule,
} from "./tables.server";

/* ============================== 结果类型 ============================== */

export type CsvRowError = { line: number; sku: string; error: string };

export type CsvImportOutcome =
    | {
        ok: false;
        code: "limit";
        violation: "rows" | "bytes";
        actual: number;
        limit: number;
    }
    | { ok: false; code: "header"; headerError: string }
    | {
        ok: true;
        imported: number;
        failed: number;
        /** 页面回显用（页面只展示前 20 条，§15.6） */
        errors: CsvRowError[];
        /** 「下载完整错误清单」的短期令牌（无失败行为 `null`） */
        errorToken: string | null;
        /** 本次写到的商品 id（用于下发 metafield 与页面回显） */
        touchedProductIds: string[];
    };

/** 错误清单的一行：原始单元格（含失败行原值）+ `error` 列（i18n key，输出时按请求语言本地化） */
export type CsvErrorCsvRow = CsvDataRow & { error: string };

/* --------------------------- 错误清单短期暂存 --------------------------- */

/**
 * 「下载完整错误清单」需要一次**独立的文件下载请求**（资源路由，见 `app.tables.export.tsx`），
 * 而导入结果是 POST 的响应体、无法带到后续 GET。这里用一个**进程内、按 shop 隔离、
 * 10 分钟 TTL** 的暂存：导入时写入并返回一次性 token，下载时按 token 取回。
 *
 * 只存 SKU 与失败原因（原始单元格），**不含顾客 PII**（§8.2 D）；超期由读取时顺带清理。
 * 导入是后台操作，进程重启后令牌失效只会让商家重新导入一次，可接受。
 */
const CSV_ERROR_TTL_MS = 10 * 60 * 1000;
type CsvErrorStash = { shop: string; rows: CsvErrorCsvRow[]; expiresAt: number };
const csvErrorStash = new Map<string, CsvErrorStash>();

/** 暂存错误清单，返回下载令牌（32 字节 base64url，不可猜测） */
export function stashCsvErrors(shop: string, rows: CsvErrorCsvRow[]): string {
    const now = Date.now();
    for (const [key, value] of csvErrorStash) {
        if (value.expiresAt <= now) csvErrorStash.delete(key);
    }
    const token = randomBytes(32).toString("base64url");
    csvErrorStash.set(token, { shop, rows, expiresAt: now + CSV_ERROR_TTL_MS });
    return token;
}

/** 取回错误清单（校验 shop 归属与有效期）；无效返回 `null` */
export function takeCsvErrors(shop: string, token: string): CsvErrorCsvRow[] | null {
    const entry = csvErrorStash.get(token);
    if (!entry) return null;
    if (entry.shop !== shop || entry.expiresAt <= Date.now()) {
        csvErrorStash.delete(token);
        return null;
    }
    return entry.rows;
}

/** 已解析出字段、但尚未做「变体匹配」的一行 */
export type ParsedCsvRow = {
    /** CSV 中的物理行号（含表头，便于商家对照文件） */
    line: number;
    sku: string;
    quantity: number;
    min: number;
    max: number | null;
    step: number;
    /** 商品级整单起订金额（十进制字符串 / `null` = 不限） */
    orderMinAmount: string | null;
    tiers: TierEntry[];
    raw: CsvDataRow;
};

/** 变体匹配结果（Admin API 侧，最小字段） */
export type SkuVariant = { variantId: string; productId: string };

/** 通过全部校验、可落库的一行 */
export type ValidCsvRow = ParsedCsvRow & SkuVariant;

/* ============================== 单元格解析 ============================== */

/** 档位三列（竖线分隔）→ 档位数组；数量与价 / 折必须一一对应，否则抛「档位不匹配」 */
function parseTierCells(row: CsvDataRow): TierEntry[] | null {
    const qtys = splitListCell(row.tier_qty);
    if (qtys.length === 0) return [];

    const percents = splitListCell(row.tier_percent);
    const prices = splitListCell(row.tier_price);

    // 模型 A（百分比）优先；两列同时给出取百分比列（与后台「模型二选一」同口径）
    const source = percents.length ? percents : prices;
    if (source.length !== qtys.length) return null;
    if (percents.length && prices.length && prices.length !== percents.length) return null;

    const rawTiers: unknown[] = [];
    for (let i = 0; i < qtys.length; i += 1) {
        const qty = Number(qtys[i]);
        if (!Number.isInteger(qty) || qty < 1) return null;
        if (percents.length) {
            const percent = parsePercentCell(source[i]);
            if (percent === undefined || percent === null) return null;
            rawTiers.push({ qty, percent });
        } else {
            const price = parseAmountCell(source[i]);
            if (price === undefined || price === null) return null;
            rawTiers.push({ qty, price });
        }
    }
    // 复用契约归一化：非法档位在这里已被拦下，能出来的一定合法
    return normalizeTiers(rawTiers);
}

/* ============================== 解析（可单测，无 Admin API） ============================== */

/**
 * 解析 + 结构校验（不含变体匹配）。返回通过结构校验的行与逐行错误。
 *
 * 校验项：SKU 必填、`quantity` 必填且为正整数、`min/max/step` 为合法正整数、
 * `order_min_amount` 为合法金额、档位列数量与取值一一对应。
 */
export function parseCsvRows(input: {
    header: string[];
    dataMatrix: string[][];
}): { parsed: ParsedCsvRow[]; errors: CsvRowError[] } {
    const rows = rowsFromMatrix(input.header, input.dataMatrix);
    const parsed: ParsedCsvRow[] = [];
    const errors: CsvRowError[] = [];

    rows.forEach((row, index) => {
        // 物理行号 = 表头(1) + 数据序号
        const line = index + 2;
        const sku = (row.sku ?? "").trim();
        if (!sku) {
            errors.push({ line, sku: "", error: "csv.err.skuMissing" });
            return;
        }

        const quantity = parsePositiveIntCell(row.quantity);
        if (quantity === undefined || quantity === null) {
            errors.push({ line, sku, error: "csv.err.quantity" });
            return;
        }

        const min = parsePositiveIntCell(row.min_qty);
        const max = parsePositiveIntCell(row.max_qty);
        const step = parsePositiveIntCell(row.step_qty);
        if (min === undefined || max === undefined || step === undefined) {
            errors.push({ line, sku, error: "csv.err.generic" });
            return;
        }

        const rawMin = min === null ? 1 : min;
        const rawMax = max ?? null;
        const rawStep = step === null ? 1 : step;
        if (validateVariantRule({ min: rawMin, max: rawMax, step: rawStep })) {
            errors.push({ line, sku, error: "csv.err.generic" });
            return;
        }

        const orderMinRaw = parseAmountCell(row.order_min_amount);
        if (orderMinRaw === undefined) {
            errors.push({ line, sku, error: "csv.err.generic" });
            return;
        }
        let orderMinAmount: string | null = null;
        if (orderMinRaw !== null) {
            try {
                orderMinAmount = normalizeOrderMinAmount(orderMinRaw);
            } catch {
                errors.push({ line, sku, error: "csv.err.generic" });
                return;
            }
        }

        const tiers = parseTierCells(row);
        if (tiers === null) {
            errors.push({ line, sku, error: "csv.err.tierMismatch" });
            return;
        }

        // 数量必须落在步长倍数与 min/max 内（与店面 `rowError` 同口径）
        const quantityProblem =
            quantity < rawMin ||
            (rawMax !== null && quantity > rawMax) ||
            (rawStep > 1 && quantity % rawStep !== 0);
        if (quantityProblem) {
            errors.push({ line, sku, error: "csv.err.quantity" });
            return;
        }

        parsed.push({
            line,
            sku,
            quantity,
            min: rawMin,
            max: rawMax,
            step: rawStep,
            orderMinAmount,
            tiers,
            raw: row,
        });
    });

    return { parsed, errors };
}

/**
 * 变体匹配 + 商品级 `order_min_amount` 一致性校验（纯函数，供单测）。
 *
 * 冲突口径（§15.5）：同一商品多行给出**不一致的非空**值 → 该商品所有行一并报错；
 * 空值不参与冲突判定（空 = 不限）。
 */
export function matchCsvRows(input: {
    parsed: ParsedCsvRow[];
    variantsBySku: Map<string, SkuVariant>;
}): { valid: ValidCsvRow[]; errors: CsvRowError[] } {
    const errors: CsvRowError[] = [];
    const matched: ValidCsvRow[] = [];

    for (const row of input.parsed) {
        const variant = input.variantsBySku.get(row.sku);
        if (!variant) {
            errors.push({ line: row.line, sku: row.sku, error: "csv.err.skuNotFound" });
            continue;
        }
        matched.push({ ...row, ...variant });
    }

    // 按商品聚合非空起订金额：出现多个不同值 → 该商品全部行报错
    const perProduct = new Map<string, Set<string>>();
    for (const row of matched) {
        if (row.orderMinAmount === null) continue;
        const set = perProduct.get(row.productId) ?? new Set<string>();
        set.add(row.orderMinAmount);
        perProduct.set(row.productId, set);
    }
    const conflicted = new Set(
        [...perProduct.entries()]
            .filter(([, values]) => values.size > 1)
            .map(([productId]) => productId),
    );

    const valid: ValidCsvRow[] = [];
    for (const row of matched) {
        if (conflicted.has(row.productId)) {
            errors.push({ line: row.line, sku: row.sku, error: "csv.err.orderMinConflict" });
            continue;
        }
        valid.push(row);
    }

    return { valid, errors };
}

/* ============================== SKU → 变体（Admin API） ============================== */

const VARIANTS_BY_SKU_QUERY = `#graphql
  query TablelyVariantsBySku($first: Int!, $query: String, $after: String) {
    productVariants(first: $first, query: $query, after: $after) {
      nodes {
        id
        sku
        product {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** 单次搜索携带的 SKU 数（控制 query 长度；对 1000 行 CSV 约 40 次请求，非 N+1） */
const SKU_CHUNK_SIZE = 25;

function escapeSkuForQuery(sku: string): string {
    // 去掉引号（避免破坏查询语法），其余字符交给 Shopify 搜索解析
    return sku.replace(/"/g, "");
}

function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/**
 * 按 SKU 批量查变体（Admin API `productVariants` 搜索，分块 OR 查询）。
 *
 * 同名 SKU 在 Shopify 内**不保证唯一**：这里保留「首个命中」，与商家直觉一致；
 * 后续行若用同名 SKU 会命中同一变体。
 */
export async function findVariantsBySkus(
    admin: GraphqlAdmin,
    skus: string[],
): Promise<Map<string, SkuVariant>> {
    const unique = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
    const found = new Map<string, SkuVariant>();
    if (unique.length === 0) return found;

    for (const group of chunk(unique, SKU_CHUNK_SIZE)) {
        const query = group.map((sku) => `sku:"${escapeSkuForQuery(sku)}"`).join(" OR ");
        let after: string | null = null;
        for (; ;) {
            const res = await admin.graphql(VARIANTS_BY_SKU_QUERY, {
                variables: { first: 250, query, after },
            });
            const json = await res.json();
            const errors = (json as { errors?: { message: string }[] })?.errors;
            if (Array.isArray(errors) && errors.length) {
                throw new Error(
                    `[tablely] findVariantsBySkus: ${errors.map((e) => e.message).join("; ")}`,
                );
            }
            const page = (json as {
                data?: {
                    productVariants?: {
                        nodes?: { id: string; sku?: string | null; product?: { id?: string } | null }[];
                        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                    };
                };
            })?.data?.productVariants;

            for (const node of page?.nodes ?? []) {
                const sku = (node.sku ?? "").trim();
                const productId = node.product?.id;
                if (!sku || !productId || found.has(sku)) continue;
                found.set(sku, { variantId: node.id, productId });
            }
            if (!page?.pageInfo?.hasNextPage) break;
            after = page.pageInfo.endCursor ?? null;
            if (!after) break;
        }
    }

    return found;
}

/* ============================== 落库 ============================== */

/**
 * 导入入口。**先限流 → 解析 → 匹配 → 校验 → 事务写入 → 下发 metafield**。
 *
 * 写入按「成功行」进行：失败行不影响成功行；返回逐行错误供页面展示与错误清单下载。
 */
export async function importCsv(input: {
    admin: GraphqlAdmin;
    shop: string;
    csvText: string;
}): Promise<CsvImportOutcome> {
    const bytes = Buffer.byteLength(input.csvText, "utf8");
    const matrix = parseCsv(input.csvText);
    const header = matrix[0] ?? [];
    const headerError = csvHeaderError(header);
    if (headerError) return { ok: false, code: "header", headerError };

    // 末尾空行（Excel 常见）不计入数据行，也不触发「行数超限」
    const dataMatrix = matrix
        .slice(1)
        .filter((cells) => cells.some((cell) => cell.trim() !== ""));

    const limits = checkCsvLimits({ rows: dataMatrix.length, bytes });
    if (!limits.ok) {
        logStructured("warn", "csv.import_rejected", {
            shop: input.shop,
            violation: limits.violation,
            actual: limits.actual,
            limit: limits.limit,
        });
        return {
            ok: false,
            code: "limit",
            violation: limits.violation,
            actual: limits.actual,
            limit: limits.limit,
        };
    }
    if (dataMatrix.length === 0) {
        return {
            ok: true,
            imported: 0,
            failed: 0,
            errors: [],
            errorToken: null,
            touchedProductIds: [],
        };
    }

    const { parsed, errors } = parseCsvRows({ header, dataMatrix });

    let variantsBySku = new Map<string, SkuVariant>();
    if (parsed.length) {
        try {
            variantsBySku = await findVariantsBySkus(
                input.admin,
                parsed.map((row) => row.sku),
            );
        } catch (error) {
            logStructured("error", "csv.import_failed", {
                shop: input.shop,
                stage: "sku_lookup",
                reason: error instanceof Error ? error.message : "unknown",
            });
            throw new TablelyError("csv.err.generic");
        }
    }

    const matched = matchCsvRows({ parsed, variantsBySku });
    const allErrors = [...errors, ...matched.errors];
    // 有失败行才暂存「完整错误清单」（原始单元格 + error 列，§15.6）
    const errorToken = allErrors.length
        ? stashCsvErrors(
            input.shop,
            buildErrorRows(header, dataMatrix, allErrors),
        )
        : null;

    if (matched.valid.length === 0) {
        return {
            ok: true,
            imported: 0,
            failed: allErrors.length,
            errors: allErrors,
            errorToken,
            touchedProductIds: [],
        };
    }

    const touched = await writeRows({ shop: input.shop, rows: matched.valid });

    for (const productId of touched) {
        await pushProductTableMetafield({
            admin: input.admin,
            shop: input.shop,
            productId,
        });
    }

    return {
        ok: true,
        imported: matched.valid.length,
        failed: allErrors.length,
        errors: allErrors,
        errorToken,
        touchedProductIds: touched,
    };
}

/**
 * 由原始数据矩阵 + 逐行错误，拼出错误清单的行（保留失败行的原值，便于对照修改）。
 * `error` 存 i18n key，实际文本在下载时按请求语言本地化（`app.tables.export.tsx`）。
 */
function buildErrorRows(
    header: string[],
    dataMatrix: string[][],
    errors: CsvRowError[],
): CsvErrorCsvRow[] {
    const rawRows = rowsFromMatrix(header, dataMatrix);
    return errors.map((error) => ({
        ...(rawRows[error.line - 2] ?? (error.sku ? { sku: error.sku } : {})),
        error: error.error,
    }));
}

/** 事务写 `ProductTable.orderMinAmount` + 逐变体 upsert `VariantRule`，返回受影响商品 id */
async function writeRows(input: {
    shop: string;
    rows: ValidCsvRow[];
}): Promise<string[]> {
    const byProduct = new Map<string, ValidCsvRow[]>();
    for (const row of input.rows) {
        const list = byProduct.get(row.productId) ?? [];
        list.push(row);
        byProduct.set(row.productId, list);
    }

    await prisma.$transaction(async (tx) => {
        for (const [productId, rows] of byProduct) {
            // 一致性已校验：同商品的多行起订金额要么全空、要么同值
            const orderMinAmount = rows.find((row) => row.orderMinAmount !== null)?.orderMinAmount ?? null;

            await tx.productTable.upsert({
                where: { shop_productId: { shop: input.shop, productId } },
                // 只动「数量与价格规则」范围：不碰布局 / 列开关 / 启用状态
                update: { orderMinAmount },
                create: {
                    shop: input.shop,
                    productId,
                    enabled: true,
                    orderMinAmount,
                },
            });

            for (const row of rows) {
                const variantId = row.variantId.includes("gid://")
                    ? row.variantId
                    : `gid://shopify/ProductVariant/${gidToNumericId(row.variantId)}`;
                await tx.variantRule.upsert({
                    where: { shop_variantId: { shop: input.shop, variantId } },
                    update: {
                        productId,
                        min: row.min,
                        max: row.max,
                        step: row.step,
                        tiers: row.tiers,
                    },
                    create: {
                        shop: input.shop,
                        productId,
                        variantId,
                        min: row.min,
                        max: row.max,
                        step: row.step,
                        tiers: row.tiers,
                    },
                });
            }
        }
    });

    return [...byProduct.keys()];
}