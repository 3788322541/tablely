import { describe, expect, it } from "vitest";

import {
    FREE_PRODUCT_LIMIT,
    TablelyError,
    gidToNumericId,
    isTablelyError,
    maxTablesForPlan,
    normalizeOrderMinAmount,
    pickOrderMinAmount,
    toVariantGid,
    validateVariantRule,
} from "./tables.server";

/**
 * Y14 整单起订金额归一化（§16.6）
 *
 * 最关键的一条：**留空 = 不限 = `null`**，绝不能落成 `0`（0 与「不限」语义相反）。
 */
describe("normalizeOrderMinAmount（Y14）", () => {
    it("留空（空串 / 空白 / null / undefined）→ null，不写 0", () => {
        expect(normalizeOrderMinAmount("")).toBeNull();
        expect(normalizeOrderMinAmount("   ")).toBeNull();
        expect(normalizeOrderMinAmount(null)).toBeNull();
        expect(normalizeOrderMinAmount(undefined)).toBeNull();
    });

    it("0 是明确输入的「成交额需 ≥ 0」，落字符串而不是 null", () => {
        expect(normalizeOrderMinAmount("0")).toBe("0.00");
    });

    it("整数与小数补足两位", () => {
        expect(normalizeOrderMinAmount("12")).toBe("12.00");
        expect(normalizeOrderMinAmount("12.5")).toBe("12.50");
        expect(normalizeOrderMinAmount(" 12.34 ")).toBe("12.34");
    });

    it("Decimal(10,2) 边界：8 位整数 + 2 位小数可用，9 位整数被拒", () => {
        expect(normalizeOrderMinAmount("99999999.99")).toBe("99999999.99");
        expect(() => normalizeOrderMinAmount("100000000")).toThrow(TablelyError);
    });

    it("非法输入（负数 / 三位小数 / 非数字）抛 error.orderMinInvalid", () => {
        for (const raw of ["-1", "1.234", "abc", "1e3", "1,5"]) {
            try {
                normalizeOrderMinAmount(raw);
                throw new Error(`应当拒绝: ${raw}`);
            } catch (error) {
                expect(isTablelyError(error)).toBe(true);
                expect((error as TablelyError).key).toBe("error.orderMinInvalid");
            }
        }
    });
});

/**
 * 单变体数量规则（min / max / step）
 *
 * 纯函数，供保存商品与「套用模板覆写规则」共用同一份判定，避免两套标准分叉。
 */
describe("validateVariantRule", () => {
    it("正向：min=1 step=1 max=null（不限）合法", () => {
        expect(validateVariantRule({ min: 1, max: null, step: 1 })).toBeNull();
    });

    it("正向：max 等于 min 合法", () => {
        expect(validateVariantRule({ min: 5, max: 5, step: 2 })).toBeNull();
    });

    it("反向：min < 1 → error.ruleMinInvalid", () => {
        expect(validateVariantRule({ min: 0, max: null, step: 1 })).toBe(
            "error.ruleMinInvalid",
        );
    });

    it("反向：step < 1 → error.ruleStepInvalid", () => {
        expect(validateVariantRule({ min: 1, max: null, step: 0 })).toBe(
            "error.ruleStepInvalid",
        );
    });

    it("反向：max < min → error.ruleMaxInvalid", () => {
        expect(validateVariantRule({ min: 3, max: 2, step: 1 })).toBe(
            "error.ruleMaxInvalid",
        );
    });

    it("反向：非整数一律拒绝", () => {
        expect(validateVariantRule({ min: 1.5, max: null, step: 1 })).toBe(
            "error.ruleMinInvalid",
        );
        expect(validateVariantRule({ min: 1, max: null, step: 1.5 })).toBe(
            "error.ruleStepInvalid",
        );
        expect(validateVariantRule({ min: 1, max: 2.5, step: 1 })).toBe(
            "error.ruleMaxInvalid",
        );
    });
});

/** 起订金额取值优先级：商品级覆写 → 店铺级默认 → 不限（§16.6） */
describe("pickOrderMinAmount", () => {
    it("商品级优先于店铺级", () => {
        expect(pickOrderMinAmount("10.00", "5.00")).toBe("10.00");
    });

    it("商品级为 null 时回落到店铺级", () => {
        expect(pickOrderMinAmount(null, "5.00")).toBe("5.00");
    });

    it("两者都为 null → 不限", () => {
        expect(pickOrderMinAmount(null, null)).toBeNull();
    });

    it("商品级为「0」（明确的 0）不会被店铺级覆盖", () => {
        expect(pickOrderMinAmount("0.00", "5.00")).toBe("0.00");
    });
});

/** GID 工具：DB 存 gid，metafield / Liquid 用纯数字 */
describe("gidToNumericId / toVariantGid", () => {
    it("gid → 纯数字", () => {
        expect(gidToNumericId("gid://shopify/ProductVariant/123456")).toBe("123456");
    });

    it("非 gid 原样返回（不抛错，交由调用方判断）", () => {
        expect(gidToNumericId("123456")).toBe("123456");
        expect(gidToNumericId("not-a-gid")).toBe("not-a-gid");
    });

    it("纯数字补成 gid", () => {
        expect(toVariantGid("123456")).toBe("gid://shopify/ProductVariant/123456");
    });

    it("已是 gid 时原样返回", () => {
        const gid = "gid://shopify/ProductVariant/123456";
        expect(toVariantGid(gid)).toBe(gid);
    });

    it("空串与非法值返回 null", () => {
        expect(toVariantGid("")).toBeNull();
        expect(toVariantGid("   ")).toBeNull();
        expect(toVariantGid("gid://shopify/Product/123")).toBeNull();
    });
});

/** Free 额度口径（§1.4 #1，按「已启用订购表的商品数」计） */
describe("maxTablesForPlan", () => {
    it("Free 档封顶 3 个", () => {
        expect(maxTablesForPlan("free")).toBe(FREE_PRODUCT_LIMIT);
    });

    it("Pro 档不限", () => {
        expect(maxTablesForPlan("pro")).toBe(Number.POSITIVE_INFINITY);
    });
});