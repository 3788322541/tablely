/**
 * 历史加购再下单 / 预填的数据源（A4 / Y15 / §15.7）—— **服务端专用**
 *
 * 数据源红线（继承 A4，不可放宽）：只用本应用自己的 `AddToCartEvent`；
 * **不读 Shopify 订单、不申请 `read_orders`（零 PCD）**。
 *
 * 一条事件 = 一次「顾客在本应用完成加购」的一行；同一次提交的多行几乎同时落库，
 * 库内**没有批次 id**。§15.7 要求「限最近一次加购、最多 50 行」，实现口径为：
 * 取最近 180 天内、该客户的最新 `take` 条事件，**按变体去重保留最新数量**，
 * 再截断到 P8 上限（`QUICK_ORDER_MAX_LINES`）—— 与页面上「你最近一次加购，最多 N 行」的文案一致。
 *
 * 归属校验（§8.2 A）：查询恒以 `shop` + `customerId` **双条件**，禁止跨客户读取。
 */

import prisma from "../db.server";
import { QUICK_ORDER_MAX_LINES } from "../perf-limits";

/** 保留期 / 可用窗口：180 天（§8.1 / §15.7） */
export const HISTORY_WINDOW_DAYS = 180;

export type HistoryLine = { variantId: string; quantity: number };

/** 最近加购的行（`variantId` 为纯数字串，与店面 `variant.id` 对齐） */
export async function recentAddToCartLines(input: {
    shop: string;
    customerId: string;
    /** 仅取某商品的行（商品页预填用；省略 = 不限商品） */
    productId?: string;
    /** 扫描的最大事件条数（默认 50，与 P8 一致） */
    take?: number;
}): Promise<HistoryLine[]> {
    if (!input.shop || !input.customerId) return [];
    const take = Math.min(input.take ?? QUICK_ORDER_MAX_LINES, QUICK_ORDER_MAX_LINES);
    const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const events = await prisma.addToCartEvent.findMany({
        where: {
            shop: input.shop,
            customerId: input.customerId,
            createdAt: { gte: since },
            ...(input.productId ? { productId: input.productId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take,
        select: { variantId: true, quantity: true },
    });

    const seen = new Map<string, number>();
    for (const event of events) {
        if (!seen.has(event.variantId)) seen.set(event.variantId, event.quantity);
    }
    return [...seen.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}