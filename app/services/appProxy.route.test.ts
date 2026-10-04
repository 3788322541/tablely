/**
 * App Proxy 回源页路由级单测（M11 / §十二 验收 16、30）
 *
 * 直接调用 `loader` / `action`（不启服务、不连库），验证两条红线：
 *   · **直连回源、无合法签名 → 401**（伪造请求写不进脏数据）；
 *   · **带合法签名 → 200 且返回 noindex 的 HTML 表单**（原生 `<form>`，无 JS 可提交）。
 *
 * 签名由 node:crypto 独立算出（不复用被测实现），确保是真正的交叉校验。
 *
 * 放在 `app/services/`（而非 `app/routes/`）：`app/routes/*.test.ts` 会被
 * React Router 的 flatRoutes 当成路由模块打进构建，导致 `node:crypto` 在浏览器端
 * 无法 externalize 而构建失败。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { action, loader } from "../routes/proxy.apply";

const SECRET = "shpss_route_secret";
const BASE = "https://tablely.zhenjunit.com/proxy/apply";

beforeAll(() => {
    process.env.SHOPIFY_API_SECRET = SECRET;
});

/** 生成带合法 App Proxy 签名的回源 URL（升序 / 无分隔符 / 多值逗号） */
function signedUrl(extra: Array<[string, string]> = []): string {
    const pairs: Array<[string, string]> = [
        ["shop", "x.myshopify.com"],
        ["path_prefix", "/apps/tablely"],
        ["timestamp", String(Math.floor(Date.now() / 1000))],
        ...extra,
    ];
    const message = [...pairs]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("");
    const params = new URLSearchParams(pairs);
    params.set("signature", createHmac("sha256", SECRET).update(message).digest("hex"));
    return `${BASE}?${params.toString()}`;
}

describe("loader（GET 回源页）", () => {
    it("无签名直连回源 → 401（验收 16 / 30）", async () => {
        const response = await loader({
            request: new Request(`${BASE}?shop=x.myshopify.com`),
        } as never);
        expect(response.status).toBe(401);
    });

    it("签名被篡改 → 401", async () => {
        const url = new URL(signedUrl());
        url.searchParams.set("shop", "evil.myshopify.com");
        const response = await loader({ request: new Request(url.toString()) } as never);
        expect(response.status).toBe(401);
    });

    it("合法签名 → 200，返回 noindex 的原生表单页（无 JS 可提交）", async () => {
        const response = await loader({
            request: new Request(signedUrl([["logged_in_customer_id", "42"]])),
        } as never);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("x-robots-tag")).toContain("noindex");

        const html = await response.text();
        expect(html).toContain('<meta name="robots" content="noindex, nofollow"');
        expect(html).toContain('action="/apps/tablely/apply"');
        expect(html).toContain('name="privacyConsent"');
        expect(html).toContain('name="country"');
    });
});

describe("action（POST 提交）", () => {
    it("无签名 → 401，不解析表单", async () => {
        const response = await action({
            request: new Request(BASE, { method: "POST", body: new FormData() }),
        } as never);
        expect(response.status).toBe(401);
    });

    it("合法签名但字段缺失 → 400（服务端二次校验拦截，不落库）", async () => {
        const response = await action({
            request: new Request(signedUrl(), { method: "POST", body: new FormData() }),
        } as never);
        expect(response.status).toBe(400);
    });
});