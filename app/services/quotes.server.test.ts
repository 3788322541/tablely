/**
 * 报价单纯逻辑单测（M13 / Y17 / §15.8）
 *
 * 只覆盖**不触 Admin API / DB 的纯函数**：
 *   · `generateQuoteToken` —— 32 字节随机、URL 安全、互不相同（不可顺序猜测）；
 *   · `normalizeValidDays` —— 默认 7 天、clamp 到 1–90（防 0 / 负数 / 超大 / 脏值）；
 *   · `computeValidUntil` —— 生成时刻 + N 天；
 *   · `isQuoteActive` —— 撤销 / 过期即失效（边界含「恰好到期」）；
 *   · `canViewWholesale` —— **红线**：仅登录且身份完全匹配才展示专属价；
 *   · `buildQuotePublicUrl` / `quoteNumber` —— 店铺同域地址、只暴露 token 前 8 位。
 *
 * 生成 / 读取 / 撤销等依赖 Prisma 与 Admin API，不在纯函数范围（集成验收覆盖）。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.server", () => ({ default: {} }));

import {
    buildQuotePublicUrl,
    canViewWholesale,
    computeValidUntil,
    generateQuoteToken,
    isQuoteActive,
    normalizeValidDays,
    QUOTE_DEFAULT_VALID_DAYS,
    quoteNumber,
} from "./quotes.server";

/* ------------------------------------------------------------------ *
 * ① token 生成
 * ------------------------------------------------------------------ */

describe("generateQuoteToken（不可猜测）", () => {
    it("32 字节 base64url → 43 字符、且仅含 URL 安全字符", () => {
        const token = generateQuoteToken();
        // 32 字节按 base64 编码为 44 字符（含 1 个 padding），base64url 去掉 '=' 即 43
        expect(token).toHaveLength(43);
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(token).not.toContain("=");
    });

    it("连续生成互不相同（无碰撞）", () => {
        const seen = new Set(Array.from({ length: 200 }, () => generateQuoteToken()));
        expect(seen.size).toBe(200);
    });
});

/* ------------------------------------------------------------------ *
 * ② 有效期天数合法化
 * ------------------------------------------------------------------ */

describe("normalizeValidDays（默认 7 天，clamp 1–90）", () => {
    it("缺失 / 空串 → 默认 7", () => {
        expect(normalizeValidDays(undefined)).toBe(QUOTE_DEFAULT_VALID_DAYS);
        expect(normalizeValidDays(null)).toBe(QUOTE_DEFAULT_VALID_DAYS);
        expect(normalizeValidDays("")).toBe(QUOTE_DEFAULT_VALID_DAYS);
        expect(normalizeValidDays("abc")).toBe(QUOTE_DEFAULT_VALID_DAYS);
    });

    it("0 / 负数 / 小数 < 1 → 回退默认 7", () => {
        expect(normalizeValidDays(0)).toBe(QUOTE_DEFAULT_VALID_DAYS);
        expect(normalizeValidDays(-3)).toBe(QUOTE_DEFAULT_VALID_DAYS);
        expect(normalizeValidDays(0.5)).toBe(QUOTE_DEFAULT_VALID_DAYS);
    });

    it("区间内原样（含字符串数字与向下取整）", () => {
        expect(normalizeValidDays(1)).toBe(1);
        expect(normalizeValidDays("30")).toBe(30);
        expect(normalizeValidDays(90)).toBe(90);
        expect(normalizeValidDays(3.9)).toBe(3);
    });

    it("超过 90 → clamp 到 90", () => {
        expect(normalizeValidDays(91)).toBe(90);
        expect(normalizeValidDays(9999)).toBe(90);
        expect(normalizeValidDays("120")).toBe(90);
    });
});

/* ------------------------------------------------------------------ *
 * ③ 失效时间
 * ------------------------------------------------------------------ */

describe("computeValidUntil（生成时刻 + N 天）", () => {
    it("正数天数按毫秒精确相加", () => {
        const created = new Date("2026-10-05T00:00:00.000Z");
        expect(computeValidUntil(created, 7).toISOString()).toBe(
            "2026-10-12T00:00:00.000Z",
        );
    });

    it("1 天 = 24 小时；90 天同样精确", () => {
        const created = new Date("2026-01-01T08:30:00.000Z");
        expect(computeValidUntil(created, 1).toISOString()).toBe(
            "2026-01-02T08:30:00.000Z",
        );
        expect(computeValidUntil(created, 90).toISOString()).toBe(
            "2026-04-01T08:30:00.000Z",
        );
    });
});

/* ------------------------------------------------------------------ *
 * ④ 可访问性判定
 * ------------------------------------------------------------------ */

describe("isQuoteActive（未撤销且未过期）", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");

    it("未撤销且未过期 → true", () => {
        expect(isQuoteActive({ revoked: false, validUntil: new Date("2026-10-06T12:00:00.000Z") }, now)).toBe(true);
    });

    it("已撤销 → false（即便未过期）", () => {
        expect(isQuoteActive({ revoked: true, validUntil: new Date("2026-10-06T12:00:00.000Z") }, now)).toBe(false);
    });

    it("已过期 → false", () => {
        expect(isQuoteActive({ revoked: false, validUntil: new Date("2026-10-04T12:00:00.000Z") }, now)).toBe(false);
    });

    it("恰好等于当前时刻 → false（严格大于才算有效）", () => {
        expect(isQuoteActive({ revoked: false, validUntil: new Date(now.getTime()) }, now)).toBe(false);
    });
});

/* ------------------------------------------------------------------ *
 * ⑤ 专属价红线（§15.8.2）
 * ------------------------------------------------------------------ */

describe("canViewWholesale（专属价只在登录且身份匹配时展示）", () => {
    it("匿名（未登录）→ false，即便报价单挂了客户", () => {
        expect(canViewWholesale({ customerId: "12345" }, null)).toBe(false);
    });

    it("报价单未挂客户 → false，任何人都看不到专属价", () => {
        expect(canViewWholesale({ customerId: null }, "12345")).toBe(false);
        expect(canViewWholesale({ customerId: null }, null)).toBe(false);
    });

    it("登录客户与报价单客户不一致 → false", () => {
        expect(canViewWholesale({ customerId: "12345" }, "99999")).toBe(false);
    });

    it("登录客户与报价单客户完全一致 → true（唯一放行条件）", () => {
        expect(canViewWholesale({ customerId: "12345" }, "12345")).toBe(true);
    });

    it("空串客户 id 视为未挂客户 → false", () => {
        expect(canViewWholesale({ customerId: "" }, "")).toBe(false);
    });
});

/* ------------------------------------------------------------------ *
 * ⑥ 地址与单号
 * ------------------------------------------------------------------ */

describe("buildQuotePublicUrl / quoteNumber", () => {
    it("店铺同域地址：https://<shop>/apps/tablely/quote/<token>", () => {
        expect(buildQuotePublicUrl("demo.myshopify.com", "abc123")).toBe(
            "https://demo.myshopify.com/apps/tablely/quote/abc123",
        );
    });

    it("单号 = token 前 8 位大写（不暴露完整 token）", () => {
        expect(quoteNumber("abcdEFGHijkl")).toBe("ABCDEFGH");
        expect(quoteNumber("abcdEFGHijkl")).toHaveLength(8);
    });
});