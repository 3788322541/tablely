import { describe, expect, it } from "vitest";

import {
    COLUMN_KEYS,
    DEFAULT_COLUMNS,
    DEFAULT_LAYOUT,
    DEFAULT_NATIVE_SELECTOR,
    buildMatrix,
    buildProductTableValue,
    buildShopSettingsValue,
    formatAmount,
    mergeColumns,
    normalizeLayout,
    pickColumnOverrides,
    toShopSettingsContract,
    type ProductTableContract,
    type ShopSettingsRowLike,
} from "./metafield.server";

/** 一份「干净」的 ShopSettings 行（各字段都是合法值），用例按需覆写 */
function shopRow(overrides: Partial<ShopSettingsRowLike> = {}): ShopSettingsRowLike {
    return {
        defaultLayout: DEFAULT_LAYOUT,
        columns: {},
        taxDisplay: "incl",
        outOfStockMode: "gray",
        gateMode: "off",
        gateTags: [],
        tierModel: "percent",
        tierEnabled: true,
        hideNative: false,
        nativeSelector: null,
        orderMinAmount: null,
        ...overrides,
    };
}

/* ============================ 列开关合并 ============================ */

/**
 * `mergeColumns` 必须与 Liquid 侧（`snippets/table-markup.liquid`）同序：
 * 默认 → Shop 级 → Product 级，后写的赢；非布尔值一律忽略（脏值不进店面契约）。
 */
describe("mergeColumns（默认 → Shop → Product）", () => {
    it("无任何来源时等于默认值", () => {
        expect(mergeColumns()).toEqual(DEFAULT_COLUMNS);
        expect(mergeColumns(null, undefined, "x", 42)).toEqual(DEFAULT_COLUMNS);
    });

    it("Shop 级覆写生效，未提及的键保持默认", () => {
        expect(mergeColumns({ id: true })).toEqual({
            ...DEFAULT_COLUMNS,
            id: true,
        });
    });

    it("Product 级覆写覆盖 Shop 级（后写的赢）", () => {
        const merged = mergeColumns({ id: true, price: false }, { price: true });
        expect(merged.id).toBe(true);
        expect(merged.price).toBe(true);
    });

    it("显式 false 不会被默认值吞掉", () => {
        expect(mergeColumns({ image: false }).image).toBe(false);
    });

    it("非布尔值（字符串 / null / 数字）被忽略", () => {
        const merged = mergeColumns({ image: "no", sku: null, id: 1 });
        expect(merged).toEqual(DEFAULT_COLUMNS);
    });

    it("返回的键集合恒等于 COLUMN_KEYS", () => {
        expect(Object.keys(mergeColumns()).sort()).toEqual([...COLUMN_KEYS].sort());
    });
});

describe("pickColumnOverrides", () => {
    it("只保留显式布尔值，不把默认值抄进覆写", () => {
        expect(pickColumnOverrides({ id: true, image: false })).toEqual({
            id: true,
            image: false,
        });
        expect(pickColumnOverrides({})).toEqual({});
        expect(pickColumnOverrides({ id: "true" })).toEqual({});
    });
});

describe("normalizeLayout", () => {
    it("合法值原样返回", () => {
        expect(normalizeLayout("matrix")).toBe("matrix");
        expect(normalizeLayout("grid")).toBe("grid");
    });

    it("null / 空串 = 继承店铺默认（返回 null）", () => {
        expect(normalizeLayout(null)).toBeNull();
        expect(normalizeLayout(undefined)).toBeNull();
        expect(normalizeLayout("")).toBeNull();
    });

    it("非法值退回 null，不写脏值进契约", () => {
        expect(normalizeLayout("carousel")).toBeNull();
        expect(normalizeLayout(3)).toBeNull();
    });
});

describe("formatAmount", () => {
    it("null / undefined / 空串 → null（留空 = 不限）", () => {
        expect(formatAmount(null)).toBeNull();
        expect(formatAmount(undefined)).toBeNull();
        expect(formatAmount("  ")).toBeNull();
    });

    it("Decimal 对象（有 toFixed）→ 两位小数字符串", () => {
        expect(formatAmount({ toFixed: () => "1000.00" })).toBe("1000.00");
    });

    it("字符串原样保留（含 0）", () => {
        expect(formatAmount("0.00")).toBe("0.00");
    });
});

/* ======================== Shop 级契约序列化 ======================== */

describe("toShopSettingsContract", () => {
    it("默认行的产物字段完整且取值符合默认", () => {
        const contract = toShopSettingsContract(shopRow());
        expect(contract).toEqual({
            v: 2,
            defaultLayout: DEFAULT_LAYOUT,
            columns: DEFAULT_COLUMNS,
            taxDisplay: "incl",
            gate: { mode: "off", tags: [] },
            outOfStock: "gray",
            orderMinAmount: null,
            tierModel: "percent",
            tierEnabled: true,
            hideNative: { enabled: false, selector: DEFAULT_NATIVE_SELECTOR },
        });
    });

    it("白名单外取值退回默认（脏值不进契约）", () => {
        const contract = toShopSettingsContract(
            shopRow({ defaultLayout: "nope", taxDisplay: "x", outOfStockMode: "y", gateMode: "z", tierModel: "q" }),
        );
        expect(contract.defaultLayout).toBe("table");
        expect(contract.taxDisplay).toBe("incl");
        expect(contract.outOfStock).toBe("gray");
        expect(contract.gate.mode).toBe("off");
        expect(contract.tierModel).toBe("percent");
    });

    it("门控标签去重去空（空串会把「无标签顾客」误放行）", () => {
        const contract = toShopSettingsContract(
            shopRow({ gateMode: "hide_price", gateTags: ["vip", " vip ", "", "  ", "tier1"] }),
        );
        expect(contract.gate).toEqual({
            mode: "hide_price",
            tags: ["vip", "tier1"],
        });
    });

    it("hideNative 选择器留空时退回内置选择器", () => {
        expect(
            toShopSettingsContract(shopRow({ hideNative: true, nativeSelector: "   " }))
                .hideNative,
        ).toEqual({ enabled: true, selector: DEFAULT_NATIVE_SELECTOR });
    });

    it("起订金额留空落 null（绝不写 0）", () => {
        expect(toShopSettingsContract(shopRow()).orderMinAmount).toBeNull();
        expect(
            toShopSettingsContract(
                shopRow({ orderMinAmount: { toFixed: () => "1000.00" } }),
            ).orderMinAmount,
        ).toBe("1000.00");
    });

    it("序列化结果是合法 JSON 且可原样解析回契约", () => {
        const contract = toShopSettingsContract(shopRow({ gateTags: ["vip"] }));
        expect(JSON.parse(buildShopSettingsValue(contract))).toEqual(contract);
    });
});

/* =================== Product 级契约序列化（A1） =================== */

describe("buildProductTableValue（A1：不含价格与库存）", () => {
    const contract: ProductTableContract = {
        v: 2,
        enabled: true,
        layout: "table",
        columns: { id: true },
        orderMinAmount: "1000.00",
        rows: [
            {
                vid: "43814503121155",
                sku: "SKU-PM-1KG",
                title: "Prehnite M 1 kg",
                min: 1,
                max: 128,
                step: 1,
                tiers: [],
                wholesale: [{ group: "tier1", price: "95.00" }],
            },
            {
                vid: "43814503153923",
                sku: null,
                title: "Prehnite M 5 kg",
                min: 1,
                max: null,
                step: 1,
                tiers: [{ qty: 5, price: "117.00" }],
                wholesale: [],
            },
        ],
        matrix: null,
    };

    it("是可解析的 JSON，且行内字段结构与契约一致", () => {
        const parsed = JSON.parse(buildProductTableValue(contract)) as ProductTableContract;
        expect(parsed).toEqual(contract);
        // 两行的键集合必须一致（v1 的行结构不一致属契约缺陷）
        expect(Object.keys(parsed.rows[0]).sort()).toEqual(
            Object.keys(parsed.rows[1]).sort(),
        );
        expect(parsed.rows[1].max).toBeNull();
    });

    it("每行**自身**不出现 price / priceIncl / stock（§十二 验收 12）", () => {
        const parsed = JSON.parse(buildProductTableValue(contract)) as ProductTableContract;
        for (const row of parsed.rows) {
            const keys = Object.keys(row);
            expect(keys).not.toContain("price");
            expect(keys).not.toContain("priceIncl");
            expect(keys).not.toContain("stock");
        }
    });

    it("整个 JSON 文本里不出现库存字段名（防止缓存实时库存）", () => {
        const text = buildProductTableValue(contract);
        expect(text).not.toContain("priceIncl");
        expect(text).not.toContain("\"stock\"");
        expect(text).not.toContain("inventory_quantity");
    });
});

/* =================== 矩阵坐标（M6：按 option 交叉） =================== */

describe("buildMatrix（矩阵布局的 option 交叉）", () => {
    // 参考场景：规格（M / XL）× 包装重量（1kg / 5kg）—— §2.3 图
    const options = [
        { name: "Size", values: ["M", "XL"] },
        { name: "Pack", values: ["1kg", "5kg"] },
    ];
    const variant = (vid: string, size: string, pack: string) => ({
        vid,
        options: [
            { name: "Size", value: size },
            { name: "Pack", value: pack },
        ],
    });
    const variants = [
        variant("1", "M", "1kg"),
        variant("2", "M", "5kg"),
        variant("3", "XL", "1kg"),
        variant("4", "XL", "5kg"),
    ];

    it("行轴 = 第 1 个 option，列轴 = 第 2 个 option，格子给出 x/y 坐标", () => {
        const matrix = buildMatrix(options, variants);
        expect(matrix).not.toBeNull();
        expect(matrix?.yAxis).toEqual({ name: "Size", values: ["M", "XL"] });
        expect(matrix?.xAxis).toEqual({ name: "Pack", values: ["1kg", "5kg"] });
        // M/1kg → y0 x0；XL/5kg → y1 x1
        expect(matrix?.cells).toEqual([
            { x: 0, y: 0, vid: "1" },
            { x: 1, y: 0, vid: "2" },
            { x: 0, y: 1, vid: "3" },
            { x: 1, y: 1, vid: "4" },
        ]);
    });

    it("option 轴不是恰好 2 个 → null（Liquid 侧降级为表格，§1.4 #3）", () => {
        expect(buildMatrix([], variants)).toBeNull();
        expect(buildMatrix([options[0]!], variants)).toBeNull();
        expect(buildMatrix([...options, { name: "Color", values: ["red"] }], variants)).toBeNull();
    });

    it("轴为空取值 / 没有可用变体 → null（不生成空矩阵）", () => {
        expect(buildMatrix([{ name: "Size", values: [] }, options[1]!], variants)).toBeNull();
        expect(buildMatrix(options, [])).toBeNull();
    });

    it("变体缺某个轴上的取值时跳过该格子（不伪造坐标）", () => {
        const matrix = buildMatrix(options, [
            variant("1", "M", "1kg"),
            { vid: "9", options: [{ name: "Size", value: "M" }] },
        ]);
        expect(matrix?.cells).toEqual([{ x: 0, y: 0, vid: "1" }]);
    });

    it("只含配置类数据，序列化后不出现价格 / 库存字段（A1）", () => {
        const text = JSON.stringify(buildMatrix(options, variants));
        expect(text).not.toContain("\"price\"");
        expect(text).not.toContain("\"stock\"");
        expect(text).not.toContain("inventory_quantity");
    });
});