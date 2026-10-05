/**
 * App Proxy 回源校验（M11 / §15.2）—— **服务端专用**
 *
 * 申请表单要让**未登录访客**也能打开，且贴在**店铺自己的域名**下
 * （`https://<shop>/apps/tablely/apply`）。App Proxy 由 Shopify 转发并自动签名，
 * 因此回源请求**不是 Admin 上下文**（没有 `host`），**绝不能** `authenticate.admin`；
 * 只能校验 `signature` 来确认「请求确实来自 Shopify 转发」，失败一律 **401 且不落库**。
 *
 * 签名算法**照抄 Shopify 官方 SDK**（`@shopify/shopify-api` 的 `validateHmac`，
 * `signator: 'appProxy'`），而不是自创：
 *   ① 去掉 `signature`，其余参数按**参数名升序**；
 *   ② 拼成 `key=value` 且**无分隔符**，多值用逗号连接（值取 URL 解码后的值）；
 *   ③ 用 `SHOPIFY_API_SECRET` 做 HMAC-SHA256，输出 **hex**（不是 webhook 那种 base64）；
 *   ④ 与 `signature` 常量时间比较；`timestamp` 与当前时间差 **>90s** 视为过期
 *      （与 SDK 的 `HMAC_TIMESTAMP_PERMITTED_CLOCK_TOLERANCE_SEC` 同口径；
 *       `timestamp` 缺失时 SDK 不拦截，这里也保持一致）。
 */

import {
    applicationLimiter,
    constantTimeEqual,
    hmacSha256Hex,
    quickOrderLimiter,
} from "./security.server";

/**
 * 顾客可见路径的真源在客户端安全的 `app/proxy-paths.ts`（后台客户端组件也要用，
 * 直接从这里导出会把 server-only 模块拖进客户端包）；此处**原样重导出**，不变更调用方。
 */
export {
    PROXY_SUBPATH,
    APPLY_PATH,
    QUICK_ORDER_PATH,
    HISTORY_PATH,
    QUOTE_PATH,
} from "../proxy-paths";

/** 时间戳容忍窗口（秒）—— 与 Shopify SDK 一致 */
export const APP_PROXY_TIMESTAMP_TOLERANCE_SEC = 90;

/** 签名校验用到的请求上下文（`shop` 取自签名参数，用于定位租户，§8.2 A） */
export type AppProxyContext = {
    shop: string;
    pathPrefix: string | null;
    /** 已登录顾客 id（可为空）；**仅用于提示「已是客户」，不写任何客户数据**（§2.4） */
    loggedInCustomerId: string | null;
    timestamp: number | null;
};

/**
 * 按官方口径拼签名串：参数名升序、`key=value` 无分隔符、多值逗号连接。
 * 导出以便单测直接断言「拼串结果」而非只测一个布尔值。
 */
export function buildAppProxySignatureMessage(
    searchParams: URLSearchParams,
): string {
    const grouped = new Map<string, string[]>();
    for (const [key, value] of searchParams) {
        if (key === "signature") continue;
        const list = grouped.get(key);
        if (list) list.push(value);
        else grouped.set(key, [value]);
    }
    return [...grouped.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((key) => `${key}=${grouped.get(key)!.join(",")}`)
        .join("");
}

/**
 * 校验 App Proxy 签名（正反两向）。`secret` 为空时**一律拒绝**
 * （绝不把空密钥当有效密钥，避免伪造请求通过）。
 */
export function verifyAppProxySignature(
    searchParams: URLSearchParams,
    secret: string | undefined,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
    if (!secret) return false;

    const signature = searchParams.get("signature");
    if (!signature) return false;

    // 注意：`URLSearchParams.get` 缺失时返回 `null`，`Number(null)` 是 0（会被误判为过期），
    // 必须先判「参数是否存在」。与 SDK 同口径：缺失 / 非数字时不拦截。
    const rawTimestamp = searchParams.get("timestamp");
    if (rawTimestamp !== null && rawTimestamp !== "") {
        const timestamp = Number(rawTimestamp);
        if (
            Number.isFinite(timestamp) &&
            Math.abs(nowSeconds - timestamp) > APP_PROXY_TIMESTAMP_TOLERANCE_SEC
        ) {
            return false;
        }
    }

    const expected = hmacSha256Hex(
        buildAppProxySignatureMessage(searchParams),
        secret,
    );
    return constantTimeEqual(expected, signature);
}

/** 从签名参数中解析回源上下文（**不校验签名**，调用方须先过 `verifyAppProxySignature`） */
export function readAppProxyContext(searchParams: URLSearchParams): AppProxyContext {
    const timestampParam = searchParams.get("timestamp");
    const rawTimestamp = timestampParam ? Number(timestampParam) : Number.NaN;
    const customerId = (searchParams.get("logged_in_customer_id") ?? "").trim();
    return {
        shop: (searchParams.get("shop") ?? "").trim(),
        pathPrefix: searchParams.get("path_prefix"),
        loggedInCustomerId: customerId || null,
        timestamp: Number.isFinite(rawTimestamp) ? rawTimestamp : null,
    };
}

/**
 * 取客户端 IP 用于限流：优先 `x-forwarded-for` 首个地址（生产经共享 edge / Caddy 转发），
 * 其次 `x-real-ip`；都取不到时退回固定桶（仍受限流约束，不因取不到 IP 就放行）。
 */
export function clientIpFromHeaders(headers: Headers): string {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) {
        const first = forwarded.split(",")[0]?.trim();
        if (first) return first;
    }
    return headers.get("x-real-ip")?.trim() || "unknown";
}

/** 申请提交限流的键：按店铺 + IP 隔离（§15.2「同 IP 10 分钟 ≤5 次」） */
export function applicationRateLimitKey(shop: string, ip: string): string {
    return `apply:${shop}:${ip}`;
}

/** 申请提交是否放行（进程内滑动窗口，口径见 `security.server.ts`） */
export function allowApplicationSubmission(shop: string, ip: string): boolean {
    return applicationLimiter.allow(applicationRateLimitKey(shop, ip));
}

/** 供单测重置限流计数 */
export function resetApplicationRateLimit(): void {
    applicationLimiter.reset();
}

/** 快速补货提交限流的键：按店铺 + IP 隔离（公开端点，防刷 Admin API） */
export function quickOrderRateLimitKey(shop: string, ip: string): string {
    return `quick-order:${shop}:${ip}`;
}

/** 快速补货提交是否放行（进程内滑动窗口，口径见 `security.server.ts`） */
export function allowQuickOrderSubmission(shop: string, ip: string): boolean {
    return quickOrderLimiter.allow(quickOrderRateLimitKey(shop, ip));
}

/** 供单测重置限流计数 */
export function resetQuickOrderRateLimit(): void {
    quickOrderLimiter.reset();
}