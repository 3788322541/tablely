/**
 * 合规 webhook 路由级单测（M15 / §8.2 C / §十二 验收 30）
 *
 * 直接调用路由的 `action`（不启服务），验证三条提审红线：
 *   · **HMAC 正确 → 200**（Shopify 不会重试）；
 *   · **HMAC 错误 / body 被篡改 → 401**（伪造投递写不进任何数据）；
 *   · **同一 X-Shopify-Webhook-Id 重复投递 → 仍 200 但只执行一次清理**（§8.1 幂等）。
 *
 * 为什么不复用 `security.test.ts`：那里测的是 `verifyWebhookHmac` 纯函数，
 * 这里测的是**真实路由走 SDK 校验链**后的 HTTP 状态（含 405 / 401 / 200 分支）。
 *
 * 两个前置条件（缺一测试会假失败）：
 *   ① `SHOPIFY_API_SECRET` 必须在 `shopify.server.ts` **被 import 之前**就位 ——
 *      SDK 在构造 `shopifyApi()` 时就把密钥读进 config，故用 `vi.hoisted` 而非 `beforeAll`；
 *   ② 不连库：mock 掉 `db.server`（含带 P2002 状态的 WebhookEvent 表）与三个清理服务。
 *
 * 放在 `app/services/`（而非 `app/routes/`）：`app/routes/*.test.ts` 会被 flatRoutes
 * 当成路由模块打进构建（先例见 appProxy.route.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const hoisted = vi.hoisted(() => {
    const SECRET = "shpss_compliance_secret";
    // 必须在 shopify.server 被 import 前设置（SDK 构造时就读取密钥与 appUrl）。
    // 本地有 .env 兜底，CI 没有 —— 所以这些值一律在测试里显式给全，避免环境差异。
    process.env.SHOPIFY_API_SECRET = SECRET;
    process.env.SHOPIFY_API_KEY ??= "test-api-key";
    process.env.SHOPIFY_APP_URL ??= "https://tablely.zhenjunit.com";

    const seen = new Set<string>();
    return {
        SECRET,
        seen,
        prisma: {
            // PrismaSessionStorage 构造时会 poll `session.count()` 确认表存在
            session: { count: async () => 0, findUnique: async () => null },
            // 以主键冲突（P2002）实现幂等去重，与生产实现同口径
            webhookEvent: {
                create: async ({ data }: { data: { id: string } }) => {
                    if (seen.has(data.id)) {
                        const error = new Error("Unique constraint failed") as Error & {
                            code: string;
                        };
                        error.code = "P2002";
                        throw error;
                    }
                    seen.add(data.id);
                    return data;
                },
            },
        },
    };
});

vi.mock("../db.server", () => ({ default: hoisted.prisma }));

vi.mock("../services/monitor.server", () => ({
    logStructured: vi.fn(),
    APP_VERSION: "test",
}));

vi.mock("../services/uninstall.server", () => ({
    cleanupShopData: vi.fn(async () => ({ applications: 0, events: 0 })),
}));

vi.mock("../services/applications.server", () => ({
    redactApplicationsByCustomer: vi.fn(async () => 2),
    summarizeApplicationsForCustomer: vi.fn(async () => [{ id: "app_1" }]),
}));

vi.mock("../services/quotes.server", () => ({
    nullifyQuotesForCustomer: vi.fn(async () => 1),
}));

import { action } from "../routes/webhooks.compliance";
import { cleanupShopData } from "../services/uninstall.server";
import { redactApplicationsByCustomer } from "../services/applications.server";

const SHOP = "tablely-test.myshopify.com";
const TOPIC = "shop/redact";
const CUSTOMERS_REDACT = "customers/redact";

// 每个用例独立：否则「已调用/未调用」的断言会互相污染
beforeEach(() => {
    vi.clearAllMocks();
});

function sign(body: string): string {
    return createHmac("sha256", hoisted.SECRET).update(body).digest("base64");
}

function webhookRequest(options: {
    body: unknown;
    topic?: string;
    webhookId: string;
    hmac?: string;
    method?: string;
}): Request {
    const body = JSON.stringify(options.body);
    return new Request("https://tablely.zhenjunit.com/webhooks/compliance", {
        method: options.method ?? "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Shopify-Hmac-Sha256": options.hmac ?? sign(body),
            "X-Shopify-Topic": options.topic ?? TOPIC,
            "X-Shopify-Shop-Domain": SHOP,
            "X-Shopify-API-Version": "2026-07",
            "X-Shopify-Webhook-Id": options.webhookId,
        },
        body: options.method === "GET" ? undefined : body,
    });
}

describe("HMAC 校验（§8.2 C）", () => {
    /**
     * 路由的失败分支是 **throw Response**（React Router 会把它当 HTTP 响应返回），
     * 所以这里统一把「返回值」与「抛出的 Response」归一成一个 Response 再断言状态码。
     */
    async function call(request: Request): Promise<Response> {
        try {
            return (await action({ request } as never)) as Response;
        } catch (thrown) {
            if (thrown instanceof Response) return thrown;
            throw thrown;
        }
    }

    it("签名正确 → 200，且执行清理", async () => {
        const response = await call(
            webhookRequest({ body: { shop_id: 1 }, webhookId: "wh_ok_1" }),
        );

        expect(response.status).toBe(200);
        expect(cleanupShopData).toHaveBeenCalledTimes(1);
        expect(vi.mocked(cleanupShopData).mock.calls[0][0]).toMatchObject({ shop: SHOP });
    });

    it("签名错误 → 401，不执行任何清理", async () => {
        const response = await call(
            webhookRequest({
                body: { shop_id: 1 },
                webhookId: "wh_bad_1",
                hmac: "not-a-valid-hmac",
            }),
        );

        expect(response.status).toBe(401);
        expect(cleanupShopData).not.toHaveBeenCalled();
    });

    it("body 被篡改（签名对不上）→ 401", async () => {
        const original = JSON.stringify({ shop_id: 1 });
        const request = new Request(
            "https://tablely.zhenjunit.com/webhooks/compliance",
            {
                method: "POST",
                headers: {
                    "X-Shopify-Hmac-Sha256": sign(original),
                    "X-Shopify-Topic": TOPIC,
                    "X-Shopify-Shop-Domain": SHOP,
                    "X-Shopify-API-Version": "2026-07",
                    "X-Shopify-Webhook-Id": "wh_tampered_1",
                },
                // 签名是对 original 算的，投递的却是篡改后的 body
                body: JSON.stringify({ shop_id: 2 }),
            },
        );

        const response = await call(request);
        expect(response.status).toBe(401);
        expect(cleanupShopData).not.toHaveBeenCalled();
    });

    it("非 POST → 405", async () => {
        const response = await call(
            webhookRequest({ body: {}, method: "GET", webhookId: "wh_get_1" }),
        );

        expect(response.status).toBe(405);
    });
});

describe("重复投递幂等（§8.1）", () => {
    it("同一 webhookId 投递两次 → 都 200，但清理只执行一次", async () => {
        const first = await action({
            request: webhookRequest({ body: { shop_id: 1 }, webhookId: "wh_dup_1" }),
        } as never);
        const second = await action({
            request: webhookRequest({ body: { shop_id: 1 }, webhookId: "wh_dup_1" }),
        } as never);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(cleanupShopData).toHaveBeenCalledTimes(1);
    });
});

describe("顾客级合规（§8.1 / §15.1）", () => {
    it("customers/redact → 删除该顾客的申请行", async () => {
        await action({
            request: webhookRequest({
                topic: CUSTOMERS_REDACT,
                webhookId: "wh_customer_1",
                body: { customer: { id: 42, email: "buyer@example.com" } },
            }),
        } as never);

        expect(redactApplicationsByCustomer).toHaveBeenCalledWith({
            shop: SHOP,
            email: "buyer@example.com",
            customerId: "42",
        });
    });
});
