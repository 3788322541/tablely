import { describe, expect, it } from "vitest";

import {
    PLAN_OPTIONS,
    PRO_FEATURES,
    TRIAL_DAYS,
    hasFeature,
    isPlanKey,
    isProLayout,
    normalizePlan,
    type ProFeature,
} from "./plan";

/**
 * M9 档位判定（§七 / §19.2 / §19.3）
 *
 * 定价数字与门控口径都必须与方案一致——这里是价格与「Free 能给什么」的单点真源。
 */
describe("normalizePlan", () => {
    it("只有 'pro' 归一为 pro，其余一律 free", () => {
        expect(normalizePlan("pro")).toBe("pro");
        expect(normalizePlan("free")).toBe("free");
        expect(normalizePlan("PRO")).toBe("free");
        expect(normalizePlan(null)).toBe("free");
        expect(normalizePlan(undefined)).toBe("free");
        expect(normalizePlan("")).toBe("free");
    });
});

describe("PLAN_OPTIONS / TRIAL_DAYS", () => {
    it("价格与方案 §1.6 一致：$4.99/月 与 $39.90/年", () => {
        expect(PLAN_OPTIONS.pro_monthly.amount).toBe(4.99);
        expect(PLAN_OPTIONS.pro_monthly.interval).toBe("EVERY_30_DAYS");
        expect(PLAN_OPTIONS.pro_annual.amount).toBe(39.9);
        expect(PLAN_OPTIONS.pro_annual.interval).toBe("ANNUAL");
    });

    it("7 天试用（§七）", () => {
        expect(TRIAL_DAYS).toBe(7);
    });

    it("isPlanKey 只认两个可售档位", () => {
        expect(isPlanKey("pro_monthly")).toBe(true);
        expect(isPlanKey("pro_annual")).toBe(true);
        expect(isPlanKey("pro")).toBe(false);
        expect(isPlanKey("")).toBe(false);
    });
});

describe("hasFeature（§19.3 单点门控）", () => {
    it("Free 对任何 Pro 功能都是 false", () => {
        for (const feature of PRO_FEATURES) {
            expect(hasFeature("free", feature)).toBe(false);
        }
    });

    it("Pro 对已登记功能为 true", () => {
        for (const feature of PRO_FEATURES) {
            expect(hasFeature("pro", feature)).toBe(true);
        }
    });

    it("未登记的 key 一律 false（防止拼错 key 就悄悄放开）", () => {
        expect(hasFeature("pro", "matrix" as ProFeature)).toBe(false);
        expect(hasFeature("pro", "" as ProFeature)).toBe(false);
    });
});

describe("isProLayout", () => {
    it("table 为 Free，其余三布局为 Pro", () => {
        expect(isProLayout("table")).toBe(false);
        expect(isProLayout("grid")).toBe(true);
        expect(isProLayout("list")).toBe(true);
        expect(isProLayout("matrix")).toBe(true);
    });

    it("null / undefined / inherit / 未知值不算 Pro 布局（继承全局，由全局判定）", () => {
        expect(isProLayout(null)).toBe(false);
        expect(isProLayout(undefined)).toBe(false);
        expect(isProLayout("inherit")).toBe(false);
        expect(isProLayout("")).toBe(false);
    });
});