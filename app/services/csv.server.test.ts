/**
 * CSV 生成 / 解析纯逻辑单测（M13 / Y16 / §15.6）—— 对应 §十二 验收 33
 *
 * 覆盖「导出 → 改 → 导入」闭环的关键约定：
 *   · RFC4180 转义：含逗号 / 双引号 / 换行的值导出后**原样导入不串列**；
 *   · UTF-8 BOM：导出带 BOM，解析时剥离（Excel 打开不乱码）；
 *   · 列头冻结：改名 / 删除 / 顺序变化 → 整体报错 `csv.err.headerMismatch`；
 *   · 错误清单 = 标准列头 + 末尾 `error` 列（同一生成器）。
 */
import { describe, expect, it } from "vitest";

import {
    CSV_HEADER,
    csvHeaderError,
    escapeCsvField,
    parseCsv,
    rowsFromMatrix,
    toErrorCsv,
    toImportCsv,
} from "./csv.server";

describe("escapeCsvField（RFC4180 转义）", () => {
    it("普通值原样输出", () => {
        expect(escapeCsvField("SKU-1")).toBe("SKU-1");
        expect(escapeCsvField("9.90")).toBe("9.90");
    });

    it("含逗号 / 双引号 / 换行 → 整体加引号，内部 \" 转义为 \"\"", () => {
        expect(escapeCsvField("a,b")).toBe('"a,b"');
        expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
        expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
        expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
    });

    it("null / undefined → 空串", () => {
        expect(escapeCsvField(null)).toBe("");
        expect(escapeCsvField(undefined)).toBe("");
    });
});

describe("toImportCsv / parseCsv — 导出后原样导入（验收 33 核心）", () => {
    it("带 UTF-8 BOM + CRLF，首行即冻结列头", () => {
        const csv = toImportCsv([{ sku: "S-1", quantity: "10" }]);
        expect(csv.charCodeAt(0)).toBe(0xfeff);
        expect(csv).toContain(CSV_HEADER.join(","));
        expect(csv).toContain("\r\n");
    });

    it("含逗号 / 双引号 / 换行的值导出再解析不串列", () => {
        const tricky = {
            sku: "SKU,SPECIAL",
            product_title: 'Widget "Pro"',
            variant_title: "line1\nline2",
            quantity: "10",
        };
        const csv = toImportCsv([tricky]);
        const matrix = parseCsv(csv);
        expect(matrix[0]).toEqual([...CSV_HEADER]);
        const [row] = rowsFromMatrix(matrix[0], matrix.slice(1));
        expect(row.sku).toBe("SKU,SPECIAL");
        expect(row.product_title).toBe('Widget "Pro"');
        expect(row.variant_title).toBe("line1\nline2");
        expect(row.quantity).toBe("10");
        // 值内的逗号没有把这一行拆成额外列
        expect(matrix[1]).toHaveLength(CSV_HEADER.length);
    });

    it("未提供的列输出空串（列数恒等于列头长度）", () => {
        const matrix = parseCsv(toImportCsv([{ sku: "S-1" }]));
        expect(matrix[1]).toHaveLength(CSV_HEADER.length);
    });

    it("解析会剥离首位 BOM（否则首列名不匹配）", () => {
        const matrix = parseCsv("\uFEFFSKU,QUANTITY\nS-1,4");
        expect(matrix[0][0]).toBe("SKU");
    });
});

describe("csvHeaderError（列头冻结，验收 33）", () => {
    it("与 CSV_HEADER 完全一致（含 BOM / 前后空白）→ null", () => {
        expect(csvHeaderError([...CSV_HEADER])).toBeNull();
        expect(
            csvHeaderError(CSV_HEADER.map((cell, i) => (i === 0 ? `\uFEFF ${cell} ` : cell))),
        ).toBeNull();
    });

    it("改名 → csv.err.headerMismatch", () => {
        const renamed = [...CSV_HEADER];
        renamed[0] = "SKU_CODE";
        expect(csvHeaderError(renamed)).toBe("csv.err.headerMismatch");
    });

    it("删除列 / 顺序变化 → csv.err.headerMismatch", () => {
        expect(csvHeaderError(CSV_HEADER.slice(1))).toBe("csv.err.headerMismatch");
        const swapped = [...CSV_HEADER];
        [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
        expect(csvHeaderError(swapped)).toBe("csv.err.headerMismatch");
    });
});

describe("toErrorCsv（错误清单 = 标准列头 + error 列）", () => {
    it("列头在标准列头后追加单个 error 列", () => {
        const csv = toErrorCsv([{ sku: "S-1", quantity: "10", error: "csv.err.quantity" }]);
        expect(csv.charCodeAt(0)).toBe(0xfeff);
        const matrix = parseCsv(csv);
        expect(matrix[0]).toEqual([...CSV_HEADER, "error"]);
        expect(matrix[1]).toHaveLength(CSV_HEADER.length + 1);
        expect(matrix[1][CSV_HEADER.length]).toBe("csv.err.quantity");
    });
});