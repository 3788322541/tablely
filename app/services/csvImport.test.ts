/**
 * CSV 导入纯逻辑单测（M13 / Y16 / §15.5）
 *
 * 只覆盖**不触 Admin API 的两个纯函数**（`parseCsvRows` / `matchCsvRows`）：
 *   · 逐行结构校验与错误码（SKU 缺失 / quantity / 档位 / 起订金额 / min-max-step）；
 *   · 逐行物理行号（含表头，便于商家对照文件）；
 *   · SKU 匹配失败 → `csv.err.skuNotFound`；
 *   · 同商品多行起订金额冲突 → 该商品**全部行**一并报错，空值不参与冲突判定。
 *
 * 落库 / metafield 下发依赖 Prisma 与 Admin API，不在纯函数范围（由集成验收覆盖）。
 */
import { describe, expect, it } from "vitest";

import { CSV_HEADER } from "./csv.server";
import { matchCsvRows, parseCsvRows, type SkuVariant } from "./csvImport.server";

/** 按列头顺序把「列名 → 值」铺成一行矩阵单元格 */
function cells(values: Record<string, string>): string[] {
    return CSV_HEADER.map((column) => values[column] ?? "");
}

/** 合法基础行（可被各用例覆盖字段） */
const baseRow: Record<string, string> = {
    sku: "SKU-1",
    variant_id: "",
    product_title: "Widget",
    variant_title: "Default",
    quantity: "10",
    min_qty: "5",
    max_qty: "100",
    step_qty: "5",
    order_min_amount: "",
    tier_qty: "",
    tier_price: "",
    tier_percent: "",
};

function sheet(rows: Record<string, string>[]) {
    return { header: [...CSV_HEADER], dataMatrix: rows.map(cells) };
}

describe("parseCsvRows — 结构校验", () => {
    it("合法行：解析出字段与默认 min/step，无错误", () => {
        const { parsed, errors } = parseCsvRows(
            sheet([{ ...baseRow, min_qty: "", step_qty: "", max_qty: "" }]),
        );
        expect(errors).toEqual([]);
        expect(parsed).toHaveLength(1);
        expect(parsed[0]).toMatchObject({
            line: 2,
            sku: "SKU-1",
            quantity: 10,
            min: 1,
            max: null,
            step: 1,
            orderMinAmount: null,
            tiers: [],
        });
    });

    it("行号从 2 起（表头占第 1 行），逐行递增", () => {
        const { parsed, errors } = parseCsvRows(
            sheet([baseRow, { ...baseRow, sku: "SKU-2" }]),
        );
        expect(errors).toEqual([]);
        expect(parsed.map((row) => row.line)).toEqual([2, 3]);
    });

    it("SKU 缺失 → csv.err.skuMissing", () => {
        const { parsed, errors } = parseCsvRows(sheet([{ ...baseRow, sku: "  " }]));
        expect(parsed).toEqual([]);
        expect(errors).toEqual([{ line: 2, sku: "", error: "csv.err.skuMissing" }]);
    });

    it("quantity 缺失 / 非正整数 → csv.err.quantity", () => {
        for (const quantity of ["", "0", "1.5", "abc"]) {
            const { errors } = parseCsvRows(sheet([{ ...baseRow, quantity }]));
            expect(errors).toEqual([{ line: 2, sku: "SKU-1", error: "csv.err.quantity" }]);
        }
    });

    it("min/max/step 非法（非整数）→ csv.err.generic", () => {
        const { errors } = parseCsvRows(sheet([{ ...baseRow, step_qty: "1.5" }]));
        expect(errors).toEqual([{ line: 2, sku: "SKU-1", error: "csv.err.generic" }]);
    });

    it("min > max（validateVariantRule 拒绝）→ csv.err.generic", () => {
        const { errors } = parseCsvRows(
            sheet([{ ...baseRow, min_qty: "10", max_qty: "5", step_qty: "1" }]),
        );
        expect(errors).toEqual([{ line: 2, sku: "SKU-1", error: "csv.err.generic" }]);
    });

    it("order_min_amount 非法（含指数 / 超两位小数）→ csv.err.generic", () => {
        for (const value of ["abc", "1e3", "1.234"]) {
            const { errors } = parseCsvRows(
                sheet([{ ...baseRow, order_min_amount: value }]),
            );
            expect(errors).toEqual([{ line: 2, sku: "SKU-1", error: "csv.err.generic" }]);
        }
    });

    it("order_min_amount 合法 → 归一化为两位小数字符串", () => {
        const { parsed, errors } = parseCsvRows(
            sheet([{ ...baseRow, order_min_amount: "1000" }]),
        );
        expect(errors).toEqual([]);
        expect(parsed[0].orderMinAmount).toBe("1000.00");
    });

    it("数量低于 min / 高于 max / 非 step 倍数 → csv.err.quantity", () => {
        const cases: Record<string, string>[] = [
            { ...baseRow, quantity: "3" }, // < min 5
            { ...baseRow, quantity: "105" }, // > max 100
            { ...baseRow, quantity: "12" }, // 非 5 的倍数
        ];
        for (const row of cases) {
            const { errors } = parseCsvRows(sheet([row]));
            expect(errors).toEqual([{ line: 2, sku: "SKU-1", error: "csv.err.quantity" }]);
        }
    });

    it("档位列：数量与百分比一一对应 → 归一化为 percent", () => {
        const { parsed, errors } = parseCsvRows(
            sheet([
                {
                    ...baseRow,
                    tier_qty: "10|50",
                    tier_percent: "5|8",
                    tier_price: "",
                },
            ]),
        );
        expect(errors).toEqual([]);
        expect(parsed[0].tiers).toEqual([
            { qty: 10, percent: 5 },
            { qty: 50, percent: 8 },
        ]);
    });

    it("档位列：无百分比时用价格列 → 归一化为 price 字符串", () => {
        const { parsed, errors } = parseCsvRows(
            sheet([
                {
                    ...baseRow,
                    tier_qty: "10|50",
                    tier_price: "9.90|8.90",
                    tier_percent: "",
                },
            ]),
        );
        expect(errors).toEqual([]);
        expect(parsed[0].tiers).toEqual([
            { qty: 10, price: "9.90" },
            { qty: 50, price: "8.90" },
        ]);
    });

    it("档位数量与取值数量不一致 → csv.err.tierMismatch", () => {
        const { errors } = parseCsvRows(
            sheet([{ ...baseRow, tier_qty: "10|50", tier_percent: "5" }]),
        );
        expect(errors).toEqual([{ line: 2, sku: "SKU-1", error: "csv.err.tierMismatch" }]);
    });
});

describe("matchCsvRows — 变体匹配与起订金额一致性", () => {
    const variant = (variantId: string, productId: string): SkuVariant => ({
        variantId,
        productId,
    });

    /** 造一行已通过结构校验的 parsed 行 */
    function parsedRow(overrides: {
        sku: string;
        orderMinAmount?: string | null;
        line?: number;
    }) {
        return {
            line: overrides.line ?? 2,
            sku: overrides.sku,
            quantity: 10,
            min: 1,
            max: null,
            step: 1,
            orderMinAmount: overrides.orderMinAmount ?? null,
            tiers: [],
            raw: {},
        };
    }

    it("SKU 未命中 → csv.err.skuNotFound", () => {
        const { valid, errors } = matchCsvRows({
            parsed: [parsedRow({ sku: "MISSING" })],
            variantsBySku: new Map(),
        });
        expect(valid).toEqual([]);
        expect(errors).toEqual([
            { line: 2, sku: "MISSING", error: "csv.err.skuNotFound" },
        ]);
    });

    it("命中 SKU → 合并出战变体 id / 商品 id", () => {
        const { valid, errors } = matchCsvRows({
            parsed: [parsedRow({ sku: "SKU-1" })],
            variantsBySku: new Map([["SKU-1", variant("gid://shopify/ProductVariant/9", "gid://shopify/Product/1")]]),
        });
        expect(errors).toEqual([]);
        expect(valid).toHaveLength(1);
        expect(valid[0]).toMatchObject({
            sku: "SKU-1",
            variantId: "gid://shopify/ProductVariant/9",
            productId: "gid://shopify/Product/1",
        });
    });

    it("同商品多行起订金额冲突 → 全部行报错（含未给值的行）", () => {
        const variants = new Map<string, SkuVariant>([
            ["A", variant("gid://shopify/ProductVariant/1", "gid://shopify/Product/10")],
            ["B", variant("gid://shopify/ProductVariant/2", "gid://shopify/Product/10")],
        ]);
        const { valid, errors } = matchCsvRows({
            parsed: [
                parsedRow({ sku: "A", orderMinAmount: "100.00", line: 2 }),
                parsedRow({ sku: "B", orderMinAmount: "200.00", line: 3 }),
            ],
            variantsBySku: variants,
        });
        expect(valid).toEqual([]);
        expect(errors).toEqual([
            { line: 2, sku: "A", error: "csv.err.orderMinConflict" },
            { line: 3, sku: "B", error: "csv.err.orderMinConflict" },
        ]);
    });

    it("空起订金额不参与冲突判定 → 同值 / 空值混合均通过", () => {
        const variants = new Map<string, SkuVariant>([
            ["A", variant("gid://shopify/ProductVariant/1", "gid://shopify/Product/10")],
            ["B", variant("gid://shopify/ProductVariant/2", "gid://shopify/Product/10")],
        ]);
        const { valid, errors } = matchCsvRows({
            parsed: [
                parsedRow({ sku: "A", orderMinAmount: "100.00" }),
                parsedRow({ sku: "B", orderMinAmount: null }),
            ],
            variantsBySku: variants,
        });
        expect(errors).toEqual([]);
        expect(valid.map((row) => row.sku)).toEqual(["A", "B"]);
    });
});