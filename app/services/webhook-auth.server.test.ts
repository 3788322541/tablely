/**
 * Webhook 鉴权兜底单测（部署规范 §10.2）
 *
 * 覆盖 `authenticateWebhookResilient` 的四条分支：
 *   · SDK 正常返回 → 原样透传；
 *   · SDK 抛 500（离线令牌续期失败）+ HMAC 有效 → 降级返回可用上下文（handler 仍会跑）；
 *   · SDK 抛 500 但 HMAC 无效 → 原样抛出（兜底**不放行**伪造请求）；
 *   · SDK 抛 401 → 原样抛出，不触发兜底（鉴权语义不变）。
 *
 * 为什么不走真实 SDK：真实故障要求「库里存在一份临期且带 refreshToken 的离线会话」
 * 并真的去请求 Shopify 换令牌，测试里既慢又依赖网络。这里直接让 `authenticate.webhook`
 * 抛出与 SDK 完全一致的 `Response(500)`，把这层逻辑单独钉死。
 *
 * 放在 `app/services/`（而非 `app/routes/`）：`app/routes/*.test.ts` 会被 flatRoutes
 * 当成路由模块打进构建（先例见 appProxy.route.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const hoisted = vi.hoisted(() => {
    process.env.SHOPIFY_API_SECRET = "shpss_webhook_auth_secret";
    return {
        webhook: vi.fn(),
        findSessionsByShop: vi.fn(),
    };
});

vi.mock("../shopify.server", () => ({
    authenticate: { webhook: hoisted.webhook },
    sessionStorage: { findSessionsByShop: hoisted.findSessionsByShop },
}));

// security.server 会 import db.server；本测试不碰库
vi.mock("../db.server", () => ({ default: {} }));

import { authenticateWebhookResilient } from "./webhook-auth.server";

const SHOP = "tablely-test.myshopify.com";
const SECRET = process.env.SHOPIFY_API_SECRET as string;

beforeEach(() => {
    vi.clearAllMocks();
});

function sign(body: string): string {
    return createHmac("sha256", SECRET).update(body).digest("base64");
}

function request(
    body: string,
    options: { topic?: string; hmac?: string; webhookId?: string } = {},
): Request {
    return new Request("https://tablely.zhenjunit.com/webhooks/compliance", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Shopify-Hmac-Sha256": options.hmac ?? sign(body),
            "X-Shopify-Topic": options.topic ?? "shop/redact",
            "X-Shopify-Shop-Domain": SHOP,
            "X-Shopify-API-Version": "2026-07",
            "X-Shopify-Webhook-Id": options.webhookId ?? "wh_1",
        },
        body,
    });
}

/** 捕获 helper 的抛错（它抛的是 `Response`，不是 `Error`） */
async function capture(request: Request): Promise<unknown> {
    try {
        await authenticateWebhookResilient(request);
        return undefined;
    } catch (thrown) {
        return thrown;
    }
}

describe("原样透传", () => {
    it("SDK 正常返回 → 直接返回同一上下文，不查会话", async () => {
        const context = { shop: SHOP, topic: "SHOP_REDACT" };
        hoisted.webhook.mockResolvedValueOnce(context);

        await expect(
            authenticateWebhookResilient(request(JSON.stringify({ shop_id: 1 }))),
        ).resolves.toBe(context);
        expect(hoisted.findSessionsByShop).not.toHaveBeenCalled();
    });
});

describe("兜底：SDK 抛 500（§10.2）", () => {
    it("HMAC 有效 → 降级返回可用上下文（topic 归一化 / 无 admin / 复用离线会话）", async () => {
        hoisted.webhook.mockRejectedValueOnce(
            new Response(undefined, { status: 500, statusText: "Internal Server Error" }),
        );
        const offline = { id: "offline_1", shop: SHOP, isOnline: false };
        hoisted.findSessionsByShop.mockResolvedValueOnce([
            { id: "online_1", shop: SHOP, isOnline: true },
            offline,
        ]);

        const body = JSON.stringify({ shop_id: 1 });
        const context = await authenticateWebhookResilient(request(body));

        expect(context.shop).toBe(SHOP);
        expect(context.topic).toBe("SHOP_REDACT");
        expect(context.webhookId).toBe("wh_1");
        expect(context.payload).toEqual({ shop_id: 1 });
        expect(context.session).toBe(offline);
        // token 已过期，Admin API 不可用 —— 必须留空，让 handler 走纯 DB 路径
        expect(context.admin).toBeUndefined();
    });

    it("HMAC 无效 → 原样抛出 500，绝不查会话", async () => {
        hoisted.webhook.mockRejectedValueOnce(new Response(undefined, { status: 500 }));

        const thrown = await capture(
            request(JSON.stringify({ shop_id: 1 }), { hmac: "not-a-valid-hmac" }),
        );

        expect(thrown).toBeInstanceOf(Response);
        expect((thrown as Response).status).toBe(500);
        expect(hoisted.findSessionsByShop).not.toHaveBeenCalled();
    });
});

describe("鉴权语义不变", () => {
    it("SDK 抛 401 → 原样抛出，不触发兜底", async () => {
        hoisted.webhook.mockRejectedValueOnce(new Response(undefined, { status: 401 }));

        const thrown = await capture(
            request(JSON.stringify({ shop_id: 1 }), { hmac: "not-a-valid-hmac" }),
        );

        expect((thrown as Response).status).toBe(401);
        expect(hoisted.findSessionsByShop).not.toHaveBeenCalled();
    });

    it("SDK 抛非 Response 错误 → 原样抛出（不被当成鉴权失败吞掉）", async () => {
        hoisted.webhook.mockRejectedValueOnce(new Error("boom"));

        const thrown = await capture(request(JSON.stringify({ shop_id: 1 })));

        expect(thrown).toBeInstanceOf(Error);
    });
});