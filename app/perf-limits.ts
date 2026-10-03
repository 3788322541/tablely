/**
 * 性能阈值常量（Y9，§2.3.1 P1–P11）
 *
 * 方案硬约束（§2.3.1 末条）：阈值必须**集中定义**，后台 TS / 主题 Liquid / 店面 JS
 * 共用同一来源，禁止各处硬编码分散。本文件是唯一来源。
 *
 * ⚠️ 改这里的数字等于改验收标准（§十二 验收 24 逐条核对 P1–P11），
 * 不要把「方便测试」当成放宽阈值的理由。
 *
 * M3 先落「后台与 CSV 相关」的阈值；M4 起的店面 bundle 体积断言（P2）与
 * 店面侧共用本文件的其余常量。
 */

/** P1 / P4：单商品订购表行数 = 单次提交行数上限（Shopify 单商品变体上限） */
export const MAX_TABLE_ROWS = 100;

/** P2：店面 JS bundle（`table-runtime`）gzip 后上限（M4 起 CI 断言） */
export const BUNDLE_MAX_GZIP_BYTES = 15 * 1024;

/** P5：后台 IndexTable 每页行数（服务端分页，不提供「全部」选项） */
export const ADMIN_PAGE_SIZE = 50;

/** P6：CSV 导入单文件上限（数据行数 / 字节数），超限在写入前拒绝，不做部分写入 */
export const CSV_MAX_ROWS = 1000;
export const CSV_MAX_BYTES = 1024 * 1024;

/** P7：批量套用布局模板单次覆盖的商品数上限 */
export const BULK_MAX_PRODUCTS = 500;

/** P8：快速补货页搜索结果条数与购物清单行数上限 */
export const QUICK_ORDER_SEARCH_LIMIT = 50;
export const QUICK_ORDER_MAX_LINES = 50;

export type CsvLimitViolation = "rows" | "bytes";

export type CsvLimitCheck =
    | { ok: true }
    | { ok: false; violation: CsvLimitViolation; actual: number; limit: number };

/**
 * P6 校验：CSV 单文件是否在「≤ 1000 行 / ≤ 1 MB」内（§15.5 / §十二 验收 24）。
 *
 * `rows` 指**数据行数**（不含表头），与验收「恰好 1000 行通过、1001 行被拒」一致。
 * 命中任一上限即整体拒绝——调用方据此在**解析与写库之前**返回可读错误并提示分批，
 * 绝不静默截断、不部分写入。
 */
export function checkCsvLimits(input: {
    rows: number;
    bytes: number;
}): CsvLimitCheck {
    if (!Number.isFinite(input.rows) || input.rows < 0) {
        return {
            ok: false,
            violation: "rows",
            actual: input.rows,
            limit: CSV_MAX_ROWS,
        };
    }
    if (input.rows > CSV_MAX_ROWS) {
        return {
            ok: false,
            violation: "rows",
            actual: input.rows,
            limit: CSV_MAX_ROWS,
        };
    }
    if (input.bytes > CSV_MAX_BYTES) {
        return {
            ok: false,
            violation: "bytes",
            actual: input.bytes,
            limit: CSV_MAX_BYTES,
        };
    }
    return { ok: true };
}

export type BulkCountCheck = {
    ok: boolean;
    limit: number;
    /** 本次实际会被处理的商品数（超限时封顶到 limit） */
    accepted: number;
    /** 被本次忽略的商品数（> 0 时必须向商家明示「分批」） */
    overflow: number;
};

/**
 * P7 校验：一次批量套用的目标商品数。
 *
 * 依据 §2.3.1「P7 超限时的行为」：**不静默截断**，而是只处理前 500 个并明确告知，
 * 其余留给商家分批重试，故这里返回 `accepted`（截断后的数量）与 `overflow`（被略过的数量）。
 */
export function checkBulkCount(count: number): BulkCountCheck {
    const total = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    return {
        ok: total <= BULK_MAX_PRODUCTS,
        limit: BULK_MAX_PRODUCTS,
        accepted: Math.min(total, BULK_MAX_PRODUCTS),
        overflow: Math.max(0, total - BULK_MAX_PRODUCTS),
    };
}