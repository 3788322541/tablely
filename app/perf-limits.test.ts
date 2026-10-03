import { describe, expect, it } from "vitest";

import {
    BULK_MAX_PRODUCTS,
    CSV_MAX_BYTES,
    CSV_MAX_ROWS,
    checkBulkCount,
    checkCsvLimits,
} from "./perf-limits";

/**
 * P6：CSV 单文件上限（§2.3.1 / §十二 验收 24）
 *
 * 验收口径：「恰好 1000 行通过、1001 行被拒」「恰好 1 MB 通过、超出被拒」，
 * 且命中上限时必须在**解析与写库之前**整体拒绝（不做部分写入）。
 */
describe("checkCsvLimits（P6）", () => {
    it("空文件通过", () => {
        expect(checkCsvLimits({ rows: 0, bytes: 0 })).toEqual({ ok: true });
    });

    it("正向：恰好 1000 行通过", () => {
        expect(checkCsvLimits({ rows: CSV_MAX_ROWS, bytes: 1024 })).toEqual({
            ok: true,
        });
    });

    it("反向：1001 行被拒，且回报 rows 违规与实际值", () => {
        expect(checkCsvLimits({ rows: CSV_MAX_ROWS + 1, bytes: 1024 })).toEqual({
            ok: false,
            violation: "rows",
            actual: CSV_MAX_ROWS + 1,
            limit: CSV_MAX_ROWS,
        });
    });

    it("正向：恰好 1 MB 通过", () => {
        expect(checkCsvLimits({ rows: 10, bytes: CSV_MAX_BYTES })).toEqual({
            ok: true,
        });
    });

    it("反向：1 MB + 1 字节被拒，且回报 bytes 违规", () => {
        expect(checkCsvLimits({ rows: 10, bytes: CSV_MAX_BYTES + 1 })).toEqual({
            ok: false,
            violation: "bytes",
            actual: CSV_MAX_BYTES + 1,
            limit: CSV_MAX_BYTES,
        });
    });

    it("行数与字节同时超限时优先报行数", () => {
        const result = checkCsvLimits({
            rows: CSV_MAX_ROWS + 5,
            bytes: CSV_MAX_BYTES + 5,
        });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.violation).toBe("rows");
    });

    it("非法行数（负数 / NaN）一律拒绝", () => {
        expect(checkCsvLimits({ rows: -1, bytes: 0 }).ok).toBe(false);
        expect(checkCsvLimits({ rows: Number.NaN, bytes: 0 }).ok).toBe(false);
    });
});

/**
 * P7：单次批量套用上限（§2.3.1）
 *
 * 验收口径：**不静默截断** —— 超限只处理前 N 个，并把被略过的数量回报给商家分批重试。
 */
describe("checkBulkCount（P7）", () => {
    it("正向：恰好 500 个，全部处理且无溢出", () => {
        expect(checkBulkCount(BULK_MAX_PRODUCTS)).toEqual({
            ok: true,
            limit: BULK_MAX_PRODUCTS,
            accepted: BULK_MAX_PRODUCTS,
            overflow: 0,
        });
    });

    it("反向：501 个只处理 500，回报 1 个溢出", () => {
        expect(checkBulkCount(BULK_MAX_PRODUCTS + 1)).toEqual({
            ok: false,
            limit: BULK_MAX_PRODUCTS,
            accepted: BULK_MAX_PRODUCTS,
            overflow: 1,
        });
    });

    it("范围内的小批量原样通过", () => {
        expect(checkBulkCount(3)).toEqual({
            ok: true,
            limit: BULK_MAX_PRODUCTS,
            accepted: 3,
            overflow: 0,
        });
    });

    it("0 / 负数 / NaN 归一为「无目标」而不是溢出", () => {
        for (const value of [0, -5, Number.NaN]) {
            expect(checkBulkCount(value)).toEqual({
                ok: true,
                limit: BULK_MAX_PRODUCTS,
                accepted: 0,
                overflow: 0,
            });
        }
    });
});