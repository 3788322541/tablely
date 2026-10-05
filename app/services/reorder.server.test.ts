/**
 * 历史加购数据源单测（M13 / A4 / Y15 / §15.7）
 *
 * 数据源红线：只用本应用 `AddToCartEvent`（不读订单）。本文件用 Prisma mock 覆盖：
 *   · 归属双条件：查询恒以 `shop` + `customerId`，缺一即返回空（禁止跨客户读取）；
 *   · 180 天窗口：`createdAt >= now - 180 天`；
 *   · 按变体去重**保留最新**（查询按 `createdAt desc`，首见即最新）；
 *   · `take` 默认 / 显式值均被 P8 上限 `QUICK_ORDER_MAX_LINES` 封顶；
 *   · `productId` 仅在有值时进入 where（实现「只取本商品」的预填）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("../db.server", () => ({
    default: { addToCartEvent: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import { HISTORY_WINDOW_DAYS, recentAddToCartLines } from "./reorder.server";
import { QUICK_ORDER_MAX_LINES } from "../perf-limits";

beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
});

/** 取出本次查询的 args.where / args.take */
function lastArgs() {
    return findMany.mock.calls.at(-1)?.[0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, unknown>;
        take: number;
    };
}

describe("recentAddToCartLines（归属与窗口）", () => {
    it("缺 shop 或 customerId → 直接返回空，不查库", async () => {
        expect(await recentAddToCartLines({ shop: "", customerId: "1" })).toEqual([]);
        expect(await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "" })).toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });

    it("查询恒带 shop + customerId 双条件（禁止跨客户读取）", async () => {
        await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42" });
        const { where } = lastArgs();
        expect(where.shop).toBe("s.myshopify.com");
        expect(where.customerId).toBe("42");
    });

    it("时间窗口为最近 180 天", async () => {
        const before = Date.now();
        await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42" });
        const gte = (lastArgs().where.createdAt as { gte: Date }).gte;
        const expected = before - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        expect(Math.abs(gte.getTime() - expected)).toBeLessThan(5000);
    });

    it("不传 productId 时不加该条件；传入时精确过滤", async () => {
        await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42" });
        expect(lastArgs().where).not.toHaveProperty("productId");

        await recentAddToCartLines({
            shop: "s.myshopify.com",
            customerId: "42",
            productId: "987",
        });
        expect(lastArgs().where.productId).toBe("987");
    });

    it("顺序按 createdAt desc（保证去重时保留最新数量）", async () => {
        await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42" });
        expect(lastArgs().orderBy).toEqual({ createdAt: "desc" });
    });
});

describe("recentAddToCartLines（去重与上限）", () => {
    it("同变体多次出现只保留首次（即最新）数量", async () => {
        findMany.mockResolvedValue([
            { variantId: "1", quantity: 8 },
            { variantId: "2", quantity: 3 },
            { variantId: "1", quantity: 2 },
        ]);
        expect(await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42" })).toEqual([
            { variantId: "1", quantity: 8 },
            { variantId: "2", quantity: 3 },
        ]);
    });

    it("take 默认 = P8 上限 50", async () => {
        await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42" });
        expect(lastArgs().take).toBe(QUICK_ORDER_MAX_LINES);
    });

    it("显式 take 超过上限时被封顶到 50", async () => {
        await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42", take: 999 });
        expect(lastArgs().take).toBe(QUICK_ORDER_MAX_LINES);
    });

    it("显式 take 小于上限时原样使用", async () => {
        await recentAddToCartLines({ shop: "s.myshopify.com", customerId: "42", take: 10 });
        expect(lastArgs().take).toBe(10);
    });
});