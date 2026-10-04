/**
 * App Proxy 签名校验单测（M11 / §15.2 / §十二 验收 16、30）
 *
 * 覆盖三点，全部**不连网、不连库**：
 *   ① 拼签名串口径：参数名升序、`key=value` 无分隔符、多值逗号连接（与官方 SDK 一致）；
 *   ② `verifyAppProxySignature` 正反两向：正向用手写串交叉校验（不复用被测实现），
 *      反向覆盖篡改 / 缺签名 / 空密钥 / 时间戳过期 / **时间戳缺失不拦截**；
 *   ③ 上下文解析 + 限流（同 IP 10 分钟 ≤5 次）。
 */
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import {
    allowApplicationSubmission,
    applicationRateLimitKey,
    buildAppProxySignatureMessage,
    clientIpFromHeaders,
    readAppProxyContext,
    resetApplicationRateLimit,
    verifyAppProxySignature,
} from "./appProxy.server";
import { APPLICATION_RATE_LIMIT } from "./security.server";

const SECRET = "shpss_test_secret";

/** 用 URLSearchParams 按「升序 + key=value + 多值逗号」拼串（独立于被测实现的手写版） */
function handWrittenMessage(pairs: Array<[string, string]>): string {
    const grouped = new Map<string, string[]>();
    for (const [key, value] of pairs) {
        if (key === "signature") continue;
        grouped.set(key, [...(grouped.get(key) ?? []), value]);
    }
    return [...grouped.keys()]
        .sort()
        .map((key) => `${key}=${grouped.get(key)!.join(",")}`)
        .join("");
}

function signMessage(message: string, secret = SECRET): string {
    return createHmac("sha256", secret).update(message).digest("hex");
}

describe("buildAppProxySignatureMessage（拼串口径）", () => {
    it("参数名升序、无分隔符、多值逗号连接", () => {
        const params = new URLSearchParams();
        params.append("b", "2");
        params.append("a", "1");
        params.append("a", "3");
        expect(buildAppProxySignatureMessage(params)).toBe("a=1,3b=2");
    });

    it("忽略 signature 本身", () => {
        const params = new URLSearchParams();
        params.set("signature", "ignored");
        params.set("shop", "x.myshopify.com");
        expect(buildAppProxySignatureMessage(params)).toBe("shop=x.myshopify.com");
    });
});

describe("verifyAppProxySignature（正反两向）", () => {
    const pairs: Array<[string, string]> = [
        ["shop", "x.myshopify.com"],
        ["path_prefix", "/apps/tablely"],
        ["timestamp", "1000"],
        ["logged_in_customer_id", "42"],
    ];
    const message = handWrittenMessage(pairs);

    it("正向：手写签名串算出的 signature 通过", () => {
        const params = new URLSearchParams(pairs);
        params.set("signature", signMessage(message));
        expect(verifyAppProxySignature(params, SECRET, 1000)).toBe(true);
    });

    it("反向：签名后被篡改（改了 shop）拒绝", () => {
        const params = new URLSearchParams(pairs);
        params.set("signature", signMessage(message));
        params.set("shop", "evil.myshopify.com");
        expect(verifyAppProxySignature(params, SECRET, 1000)).toBe(false);
    });

    it("反向：缺失 signature 拒绝（直连回源无签名 → 401）", () => {
        expect(verifyAppProxySignature(new URLSearchParams(pairs), SECRET, 1000)).toBe(false);
    });

    it("反向：密钥不符拒绝", () => {
        const params = new URLSearchParams(pairs);
        params.set("signature", signMessage(message, "shpss_other"));
        expect(verifyAppProxySignature(params, SECRET, 1000)).toBe(false);
    });

    it("反向：secret 为空一律拒绝（不把空密钥当有效密钥）", () => {
        const params = new URLSearchParams(pairs);
        params.set("signature", signMessage(message, ""));
        expect(verifyAppProxySignature(params, "", 1000)).toBe(false);
        expect(verifyAppProxySignature(params, undefined, 1000)).toBe(false);
    });

    it("反向：时间戳超出容忍窗口拒绝；边界内放行", () => {
        const params = new URLSearchParams(pairs);
        params.set("signature", signMessage(message));
        expect(verifyAppProxySignature(params, SECRET, 1000 + 91)).toBe(false);
        expect(verifyAppProxySignature(params, SECRET, 1000 - 91)).toBe(false);
        expect(verifyAppProxySignature(params, SECRET, 1000 + 90)).toBe(true);
    });

    it("时间戳缺失时不因时间拦截（与 SDK 同口径）", () => {
        const noTimestamp: Array<[string, string]> = [
            ["shop", "x.myshopify.com"],
            ["path_prefix", "/apps/tablely"],
        ];
        const params = new URLSearchParams(noTimestamp);
        params.set("signature", signMessage(handWrittenMessage(noTimestamp)));
        expect(verifyAppProxySignature(params, SECRET, 1_000_000)).toBe(true);
    });
});

describe("readAppProxyContext", () => {
    it("解析 shop / path_prefix / logged_in_customer_id / timestamp", () => {
        const params = new URLSearchParams([
            ["shop", "x.myshopify.com"],
            ["path_prefix", "/apps/tablely"],
            ["logged_in_customer_id", "42"],
            ["timestamp", "1000"],
        ]);
        expect(readAppProxyContext(params)).toEqual({
            shop: "x.myshopify.com",
            pathPrefix: "/apps/tablely",
            loggedInCustomerId: "42",
            timestamp: 1000,
        });
    });

    it("未登录顾客：logged_in_customer_id 为空 → null；timestamp 缺失 → null", () => {
        const params = new URLSearchParams([["shop", "x.myshopify.com"]]);
        expect(readAppProxyContext(params)).toEqual({
            shop: "x.myshopify.com",
            pathPrefix: null,
            loggedInCustomerId: null,
            timestamp: null,
        });
    });
});

describe("clientIpFromHeaders", () => {
    it("优先 XFF 首个地址", () => {
        const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
        expect(clientIpFromHeaders(headers)).toBe("1.2.3.4");
    });

    it("无 XFF 时用 x-real-ip；都没有时回退固定桶", () => {
        expect(clientIpFromHeaders(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
        expect(clientIpFromHeaders(new Headers())).toBe("unknown");
    });
});

describe("申请提交限流（同 IP 10 分钟 ≤5 次）", () => {
    it("第 6 次拒绝；不同键互不影响", () => {
        resetApplicationRateLimit();
        const key = applicationRateLimitKey("x.myshopify.com", "1.2.3.4");
        expect(APPLICATION_RATE_LIMIT.max).toBe(5);

        for (let i = 0; i < APPLICATION_RATE_LIMIT.max; i += 1) {
            expect(allowApplicationSubmission("x.myshopify.com", "1.2.3.4")).toBe(true);
        }
        expect(allowApplicationSubmission("x.myshopify.com", "1.2.3.4")).toBe(false);
        // 另一个 IP / 另一个店铺仍是独立窗口
        expect(allowApplicationSubmission("x.myshopify.com", "5.6.7.8")).toBe(true);
        expect(allowApplicationSubmission("y.myshopify.com", "1.2.3.4")).toBe(true);
        expect(key).toBe("apply:x.myshopify.com:1.2.3.4");
    });
});