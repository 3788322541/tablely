/**
 * 快速补货落脚页纯逻辑单测（M13 / §15.4 / §15.7）
 *
 * 只覆盖**不触 Admin API / DB 的四个纯函数**：
 *   · `truncateToLimit` —— P8 上限截断 + 明示标志（不静默丢弃）；
 *   · `parsePasteList` —— 每行 `SKU,数量`，无逗号 = 数量未指定，非法数量入错误清单；
 *   · `parseCsvList` —— 列按名定位、缺 `sku` 列整体报错、逐行失败不整单失败；
 *   · `legalizeQuantity` —— 先吸附 step 再 clamp min/max（§15.7）。
 *
 * SKU 匹配（Admin API）、规则 / 档位 / 混单（DB）不在纯函数范围（集成验收覆盖）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({ default: {} }));

import {
    legalizeQuantity,
    parseCsvList,
    parsePasteList,
    truncateToLimit,
} from "./quickOrder.server";

/* ------------------------------------------------------------------ *
 * ① P8 上限截断
 * ------------------------------------------------------------------ */

describe("truncateToLimit（P8 上限，超限要明示）", () => {
    it("未超限原样返回，标志为 false", () => {
        const rows = [1, 2, 3];
        expect(truncateToLimit(rows, 3)).toEqual({ rows, overLimit: false });
    });

    it("超限截断到上限，标志为 true（不静默丢弃）", () => {
        const rows = Array.from({ length: 5 }, (_, i) => i);
        expect(truncateToLimit(rows, 3)).toEqual({ rows: [0, 1, 2], overLimit: true });
    });

    it("默认上限 = QUICK_ORDER_MAX_LINES（50）", () => {
        const rows = Array.from({ length: 51 }, (_, i) => i);
        const result = truncateToLimit(rows);
        expect(result.rows).toHaveLength(50);
        expect(result.overLimit).toBe(true);
    });
});

/* ------------------------------------------------------------------ *
 * ② 粘贴清单解析
 * ------------------------------------------------------------------ */

describe("parsePasteList（每行 `SKU,数量`）", () => {
    it("带逗号 = 显式数量；无逗号 = 数量未指定（null）", () => {
        expect(parsePasteList("A-1,12\nB-2")).toEqual({
            rows: [
                { sku: "A-1", quantity: 12 },
                { sku: "B-2", quantity: null },
            ],
            invalid: [],
        });
    });

    it("忽略空行与首尾空白，SKU 两侧空白被裁掉", () => {
        expect(parsePasteList("\n  A-1 , 3 \n\n  \n")).toEqual({
            rows: [{ sku: "A-1", quantity: 3 }],
            invalid: [],
        });
    });

    it("数量非法（非正整数 / 0 / 负数 / 小数）整行入错误清单", () => {
        const { rows, invalid } = parsePasteList("A-1,abc\nB-2,0\nC-3,-1\nD-4,1.5");
        expect(rows).toEqual([]);
        expect(invalid).toEqual(["A-1,abc", "B-2,0", "C-3,-1", "D-4,1.5"]);
    });

    it("SKU 为空（行首逗号）整行入错误清单", () => {
        const { rows, invalid } = parsePasteList(",5");
        expect(rows).toEqual([]);
        expect(invalid).toEqual([",5"]);
    });

    it("SKU 含逗号时的切分只在第一个逗号处（数量列取其后全部）", () => {
        // `A,1,9` → sku = "A"，数量列 = "1,9"（非法，因为不是纯整数）
        expect(parsePasteList("A,1,9").invalid).toEqual(["A,1,9"]);
    });
});

/* ------------------------------------------------------------------ *
 * ③ CSV 清单解析
 * ------------------------------------------------------------------ */

describe("parseCsvList（列按名定位）", () => {
    it("按列名定位 sku / quantity，与列顺序无关", () => {
        const csv = "quantity,sku\n7,S-1\n,S-2";
        expect(parseCsvList(csv)).toEqual({
            rows: [
                { sku: "S-1", quantity: 7 },
                { sku: "S-2", quantity: null },
            ],
            invalid: [],
            error: null,
        });
    });

    it("无 quantity 列时全部按「数量未指定」处理", () => {
        const result = parseCsvList("sku,product_title\nS-1,Widget");
        expect(result.rows).toEqual([{ sku: "S-1", quantity: null }]);
        expect(result.error).toBeNull();
    });

    it("缺 sku 列 → 整体报错 csv.err.headerMismatch", () => {
        expect(parseCsvList("quantity\n5")).toEqual({
            rows: [],
            invalid: [],
            error: "csv.err.headerMismatch",
        });
    });

    it("空内容 → csv.empty", () => {
        expect(parseCsvList("").error).toBe("csv.empty");
    });

    it("数量非法 / SKU 缺失逐行报错，合法行仍保留（不整单失败）", () => {
        const csv = "sku,quantity\nS-1,3\nS-2,abc\n,9";
        const result = parseCsvList(csv);
        expect(result.error).toBeNull();
        expect(result.rows).toEqual([{ sku: "S-1", quantity: 3 }]);
        expect(result.invalid.map((row) => row.line)).toEqual([3, 4]);
    });

    it("整行皆空（Excel 尾随空行）跳过，不报错", () => {
        expect(parseCsvList("sku,quantity\nS-1,2\n,")).toEqual({
            rows: [{ sku: "S-1", quantity: 2 }],
            invalid: [],
            error: null,
        });
    });

    it("带 BOM / 大写列头仍能识别（列名大小写不敏感）", () => {
        const result = parseCsvList("\uFEFFSKU,QUANTITY\nS-1,4");
        expect(result.rows).toEqual([{ sku: "S-1", quantity: 4 }]);
    });
});

/* ------------------------------------------------------------------ *
 * ④ 数量合法化（§15.7）
 * ------------------------------------------------------------------ */

describe("legalizeQuantity（吸附 step → clamp min/max）", () => {
    it("未指定（null）/ 非法 → 取 min", () => {
        expect(legalizeQuantity(null, 6, null, 1)).toBe(6);
        expect(legalizeQuantity(0, 6, null, 1)).toBe(6);
        expect(legalizeQuantity(-3, 6, null, 1)).toBe(6);
        expect(legalizeQuantity(NaN, 6, null, 1)).toBe(6);
    });

    it("吸附到 step 的整数倍（向上）", () => {
        expect(legalizeQuantity(7, 1, null, 6)).toBe(12);
        expect(legalizeQuantity(12, 1, null, 6)).toBe(12);
        expect(legalizeQuantity(13, 1, null, 6)).toBe(18);
    });

    it("低于 min 抬到 min（先吸附再抬）", () => {
        expect(legalizeQuantity(3, 6, null, 2)).toBe(6);
        expect(legalizeQuantity(5, 6, null, 4)).toBe(8);
    });

    it("超上限落到上限（上限低于 min 时保底 min，绝不产出非法值）", () => {
        expect(legalizeQuantity(999, 1, 100, 1)).toBe(100);
        expect(legalizeQuantity(999, 6, 4, 2)).toBe(6);
    });

    it("非法 step / min 退回 1", () => {
        expect(legalizeQuantity(5, -3, null, 0)).toBe(5);
        expect(legalizeQuantity(5, 0, null, -2)).toBe(5);
    });
});