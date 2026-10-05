import type { LoaderFunctionArgs } from "react-router";

import { hasFeature } from "../plan";
import { readAppProxyContext } from "../services/appProxy.server";
import { signatureGate } from "../services/proxyPage.server";
import { recentAddToCartLines } from "../services/reorder.server";
import { resolvePlan } from "../services/tables.server";

/**
 * 历史加购预填接口（M13 / Y15 / §15.7）—— **App Proxy 回源接口（JSON）**
 *
 * 店面订购表顶部「按上次数量预填」按钮（**手动触发**）点击前会先打这个接口问：
 * 这位顾客在**最近 180 天内**是否通过本应用为**本商品**加购过？返回行就显出按钮。
 *
 * 硬约束：
 *   · 数据源只用本应用自己的 `AddToCartEvent`（**不读 Shopify 订单 / 零 PCD**，A4）；
 *   · **按 `shop` + `customerId` 双条件**查询，禁止跨客户读取（§8.2 A）；
 *   · **未登录不可用**：无 `logged_in_customer_id` → 返回空列表（按钮本就不显示）；
 *   · 属 Pro（`reorder`）；非 Pro 也返回空列表（不泄露是否有记录）；
 *   · 只读接口，**不落库、不做任何写操作**；返回体不含任何 PII（只有变体 id 与数量）。
 */

const JSON_HEADERS: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
};

function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), { headers: JSON_HEADERS });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const url = new URL(request.url);
    const rejected = signatureGate(url.searchParams, "appproxy.history_rejected");
    if (rejected) return rejected;

    const context = readAppProxyContext(url.searchParams);
    const rawProductId = (url.searchParams.get("productId") ?? "").trim();
    const productId = /^\d+$/.test(rawProductId) ? rawProductId : undefined;

    let lines: { variantId: string; quantity: number }[] = [];
    if (context.shop && context.loggedInCustomerId) {
        const plan = await resolvePlan(context.shop);
        if (hasFeature(plan, "reorder")) {
            lines = await recentAddToCartLines({
                shop: context.shop,
                customerId: context.loggedInCustomerId,
                productId,
            });
        }
    }

    return jsonResponse({ lines });
};