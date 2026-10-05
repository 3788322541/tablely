/**
 * App Proxy 回源页共用件（M13）—— **服务端专用**
 *
 * 快速补货（`proxy.quick-order`）、历史预填接口（`proxy.history`）与报价单打印视图
 * （`proxy.quote`）同属「店铺同域、非 Admin 上下文、公开但 noindex」的回源页，
 * 共用同一套响应头 / 转义 / 基础样式 / 签名闸门，避免三份各写一套导致安全口径分叉。
 *
 * 三条硬约束（与 `proxy.apply.tsx` 一致，缘由见该文件）：
 *   ① 无 JS 也能读 / 提交 —— 页面不水合，表单用原生 `<form method="post">`；
 *   ② 非 Admin 上下文 —— 只校验 App Proxy 签名，失败一律 **401**；
 *   ③ 公开但 noindex —— `X-Robots-Tag` + `<meta robots>` 双保险。
 */

import { verifyAppProxySignature } from "./appProxy.server";
import { logStructured } from "./monitor.server";

/** 回源页统一响应头：HTML + 不缓存 + 不进搜索引擎（§15.3） */
export const HTML_HEADERS: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
};

export function htmlResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: HTML_HEADERS });
}

/** 签名缺失 / 非法 / 过期：401，不渲染任何内容（§十二 验收 16、30） */
export function unauthorized(): Response {
    return new Response("Unauthorized", {
        status: 401,
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow",
        },
    });
}

/** 所有插值（用户输入 / 文案）都过一遍，避免把店面变成 HTML 注入点 */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** 应用自己的隐私页（Y11 / §8.3）：公开免鉴权，回源页页脚必须可达 */
export function privacyUrl(): string {
    const base = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
    return `${base}/privacy`;
}

/**
 * 基础样式（自包含、无 `!important`、浅深色自适应）。
 * 各页在 `pageShell` 的 `styles` 参数里**追加**自己的样式，不覆盖本表。
 */
export const BASE_STYLES = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1a1a1a;--muted:#6b7177;--line:#e3e3e3;--field:#ffffff;--accent:#111111;--danger:#b42318;--ok:#0f7a3d}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#f2f2f2;--muted:#a1a7ad;--line:#333333;--field:#1c1c1c;--accent:#f2f2f2;--danger:#f97066;--ok:#6ee7a8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:32px 20px 56px}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 8px}
h2{font-size:1.1rem;margin:28px 0 10px}
p{margin:0 0 12px}
.muted{color:var(--muted);font-size:.9rem}
.note{font-size:.85rem;color:var(--muted);margin:0 0 20px}
.banner{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:12px 14px;margin:0 0 20px;font-size:.9rem}
.banner.err{border-left-color:var(--danger);color:var(--danger)}
.banner.info{border-left-color:var(--ok);color:var(--ok)}
.banner.warn{border-left-color:#b25e09;color:#b25e09}
.field{margin:0 0 14px}
label,.legend{display:block;font-weight:600;font-size:.92rem;margin:0 0 6px}
input[type=text],input[type=number],input[type=file],select,textarea{
  width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:inherit;font:inherit}
textarea{min-height:110px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{padding:11px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer;margin-top:4px}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
button.link{background:none;border:0;color:var(--muted);text-decoration:underline;padding:2px 0;margin:0;font-weight:400;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
.card{border:1px solid var(--line);border-radius:12px;padding:18px;margin:0 0 16px}
.center{text-align:center}
table{width:100%;border-collapse:collapse;margin:0 0 16px;font-size:.92rem}
th,td{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:middle}
th{font-weight:600;color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.02em}
td.qty{width:110px}
td.qty input{width:88px}
tfoot td{font-weight:600;border-bottom:0}
footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);font-size:.82rem;color:var(--muted)}
a{color:inherit}
ul.plain{margin:0;padding-left:1.1rem}
`;

/** 页面外壳：`styles` 追加在基础样式之后（不覆盖） */
export function pageShell(options: {
    locale: string;
    title: string;
    body: string;
    styles?: string;
    /** 用于打印视图在 `<body>` 上挂 class（如 `print`） */
    bodyAttrs?: string;
}): string {
    const { locale, title, body, styles, bodyAttrs } = options;
    return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLES}${styles ?? ""}</style>
</head>
<body${bodyAttrs ? ` ${bodyAttrs}` : ""}><main class="wrap">${body}</main></body>
</html>`;
}

/**
 * 校验 App Proxy 签名；非法时返回 401 响应，合法时返回 null（放行）。
 * `event` 是日志事件名（只记事件与店铺，不打印 signature / secret，§8.2 D / §21.5）。
 */
export function signatureGate(
    searchParams: URLSearchParams,
    event: string,
): Response | null {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!verifyAppProxySignature(searchParams, secret)) {
        logStructured("warn", event, {
            reason: "signature",
            shop: searchParams.get("shop") ?? undefined,
        });
        return unauthorized();
    }
    return null;
}