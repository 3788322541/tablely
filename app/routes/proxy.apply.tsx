import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
    APPLICATION_FIELDS,
    countryName,
    validateApplication,
    valuesFromFormData,
    type ApplicationErrors,
    type ApplicationField,
    type ApplicationValues,
} from "../applications";
import { getT, localeFromRequest, type Locale, type TFunc } from "../i18n";
import {
    APPLY_PATH,
    allowApplicationSubmission,
    clientIpFromHeaders,
    readAppProxyContext,
    verifyAppProxySignature,
    type AppProxyContext,
} from "../services/appProxy.server";
import { createWholesaleApplication } from "../services/applications.server";
import { logStructured } from "../services/monitor.server";
import { isTablelyError } from "../services/tables.server";

/**
 * 分销商申请表单（M11 / B2 / §15.2）—— **App Proxy 回源页**
 *
 * 顾客访问 `https://<shop>/apps/tablely/apply`，Shopify 转发+签名到本路由
 * （`[app_proxy] url = .../proxy` → 本文件 = `/proxy/apply`）。
 *
 * 三条硬约束决定了本文件的写法：
 *   ① **无 JS 也能提交** —— 回源页是 `resource route`（无 default export，不水合），
 *      表单是**原生 `<form method="post">`**，不依赖任何客户端脚本。因此在店面域名下
 *      不会加载后台 bundle，也不会因 JS 被拦截而不可用。
 *   ② **非 Admin 上下文** —— 命中此路由的请求没有 `host` 参数，**绝不能**
 *      `authenticate.admin`；只校验 App Proxy 签名（HS256 hex），失败一律 **401 且不落库**。
 *   ③ **公开但 noindex** —— 未登录访客可访问，`X-Robots-Tag` + `<meta robots>` 双保险。
 *
 * 提交路径：签名 → 限流（同 IP 10 分钟 ≤5 次）→ 解析 → **服务端二次校验**
 * （与前端同一份 `validateApplication`）→ 落库 `pending`。校验失败**不落库**并回显。
 */

/* ============================== 响应与转义 ============================== */

/** 回源页统一响应头：HTML + 不缓存 + 不进搜索引擎（§15.3） */
const HTML_HEADERS: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
};

function htmlResponse(body: string, status = 200): Response {
    return new Response(body, { status, headers: HTML_HEADERS });
}

/** 签名缺失 / 非法 / 过期：401，不渲染表单，也不落库（§十二 验收 16、30） */
function unauthorized(): Response {
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
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** 应用自己的隐私页（Y11 / §8.3）：公开免鉴权，门店表单页脚必须可达 */
function privacyUrl(): string {
    const base = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
    return `${base}/privacy`;
}

/* ============================== 视觉（自包含、无 !important） ============================== */

const STYLES = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1a1a1a;--muted:#6b7177;--line:#e3e3e3;--field:#ffffff;--accent:#111111;--danger:#b42318;--ok:#0f7a3d}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#f2f2f2;--muted:#a1a7ad;--line:#333333;--field:#1c1c1c;--accent:#f2f2f2;--danger:#f97066;--ok:#6ee7a8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:32px 20px 56px}
h1{font-size:1.5rem;line-height:1.3;margin:0 0 8px}
p{margin:0 0 12px}
.muted{color:var(--muted);font-size:.9rem}
.note{font-size:.85rem;color:var(--muted);margin:0 0 20px}
.banner{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:12px 14px;margin:0 0 20px;font-size:.9rem}
.banner.err{border-left-color:var(--danger);color:var(--danger)}
.banner.info{border-left-color:var(--ok);color:var(--ok)}
form{display:block}
.field{margin:0 0 18px}
label,.legend{display:block;font-weight:600;font-size:.92rem;margin:0 0 6px}
.req{color:var(--danger);margin-left:2px}
input[type=text],input[type=tel],input[type=email],input[type=url],select,textarea{
  width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:inherit;font:inherit}
textarea{min-height:96px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,.choice input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
fieldset{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0}
legend{padding:0 4px}
.choice{display:flex;align-items:flex-start;gap:8px;font-weight:400;margin:6px 0;cursor:pointer}
.choice input{margin-top:4px;flex:0 0 auto}
.hint{font-size:.82rem;color:var(--muted);margin:6px 0 0}
.err{font-size:.82rem;color:var(--danger);margin:6px 0 0}
button{width:100%;padding:12px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer;margin-top:8px}
.card{border:1px solid var(--line);border-radius:12px;padding:20px}
.center{text-align:center}
footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);font-size:.82rem;color:var(--muted)}
a{color:inherit}
`;

/* ============================== 字段渲染 ============================== */

/** 选项文案：国家走 `Intl.DisplayNames`，其余走 `optionKeyPrefix` */
function optionLabel(
    field: ApplicationField,
    option: string,
    locale: Locale,
    t: TFunc,
): string {
    if (field.key === "country") return countryName(option, locale);
    return field.optionKeyPrefix ? t(`${field.optionKeyPrefix}.${option}`) : option;
}

function renderField(
    field: ApplicationField,
    values: ApplicationValues,
    errors: ApplicationErrors,
    locale: Locale,
    t: TFunc,
): string {
    const raw = values[field.key];
    const error = errors[field.key];
    const label = t(field.labelKey);
    const hint = field.hintKey ? t(field.hintKey) : "";
    const id = `f-${field.key}`;
    const errId = `e-${field.key}`;
    const describedBy = error || hint ? ` aria-describedby="${errId}"` : "";
    const invalid = error ? ' aria-invalid="true"' : "";
    const requiredMark = field.required
        ? ` <span class="req" aria-hidden="true">*</span>`
        : "";

    const hintHtml = hint ? `<p class="hint" id="${errId}">${escapeHtml(hint)}</p>` : "";
    const errorHtml = error
        ? `<p class="err" id="${errId}" role="alert">${escapeHtml(t(error))}</p>`
        : "";
    const wrap = (control: string, labelHtml: string) =>
        `<div class="field">${labelHtml}${control}${error ? errorHtml : hintHtml}</div>`;

    const labelHtml = `<label for="${id}">${escapeHtml(label)}${requiredMark}</label>`;

    if (field.type === "select") {
        const current = String(raw ?? "");
        const placeholder = `<option value="">${escapeHtml(t("apply.opt.select"))}</option>`;
        const options = (field.options ?? [])
            .map((option) => {
                const selected = option === current ? " selected" : "";
                return `<option value="${escapeHtml(option)}"${selected}>${escapeHtml(optionLabel(field, option, locale, t))}</option>`;
            })
            .join("");
        const required = field.required ? " required" : "";
        return wrap(
            `<select id="${id}" name="${field.key}"${required}${describedBy}${invalid}>${placeholder}${options}</select>`,
            labelHtml,
        );
    }

    if (field.type === "multi" || field.type === "radio") {
        const selected = field.type === "multi"
            ? Array.isArray(raw)
                ? raw.map((item) => String(item))
                : []
            : [];
        const currentRadio = String(raw ?? "");
        const choices = (field.options ?? [])
            .map((option) => {
                const checked = field.type === "multi"
                    ? selected.includes(option)
                    : currentRadio === option;
                return `<label class="choice"><input type="${field.type === "multi" ? "checkbox" : "radio"}" name="${field.key}" value="${escapeHtml(option)}"${checked ? " checked" : ""} /><span>${escapeHtml(optionLabel(field, option, locale, t))}</span></label>`;
            })
            .join("");
        const control = `<fieldset${invalid}${describedBy}>${choices}</fieldset>`;
        return wrap(
            control,
            `<span class="legend">${escapeHtml(label)}${requiredMark}</span>`,
        );
    }

    if (field.type === "textarea") {
        const max = field.maxLength ? ` maxlength="${field.maxLength}"` : "";
        const required = field.required ? " required" : "";
        const content = raw ? escapeHtml(String(raw)) : "";
        return wrap(
            `<textarea id="${id}" name="${field.key}"${max}${required}${describedBy}${invalid}>${content}</textarea>`,
            labelHtml,
        );
    }

    if (field.type === "checkbox") {
        const checked = raw === true ? " checked" : "";
        // 隐私同意：勾选文案后附隐私政策链接（§15.3）
        const link =
            field.key === "privacyConsent"
                ? ` <a href="${escapeHtml(privacyUrl())}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("apply.privacyLink"))}</a>`
                : "";
        return wrap(
            `<label class="choice"><input id="${id}" type="checkbox" name="${field.key}" value="on"${checked}${invalid} /> <span>${escapeHtml(label)}${link}</span></label>`,
            "",
        );
    }

    // text / tel / email / url
    const max = field.maxLength ? ` maxlength="${field.maxLength}"` : "";
    const required = field.required ? " required" : "";
    const value = raw ? escapeHtml(String(raw)) : "";
    return wrap(
        `<input id="${id}" type="${field.type}" name="${field.key}" value="${value}"${max}${required}${describedBy}${invalid} />`,
        labelHtml,
    );
}

/* ============================== 页面渲染 ============================== */

function emptyValues(): ApplicationValues {
    const values: ApplicationValues = {};
    for (const field of APPLICATION_FIELDS) {
        values[field.key] =
            field.type === "multi" ? [] : field.type === "checkbox" ? false : "";
    }
    return values;
}

function pageShell(locale: Locale, title: string, body: string): string {
    return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><main class="wrap">${body}</main></body>
</html>`;
}

/** 成功页：只承诺「会尽快审核」，不承诺时间、不发邮件（§15.2 Y4） */
function successPage(locale: Locale, t: TFunc): Response {
    const body = `<section class="card center">
<h1>${escapeHtml(t("apply.successTitle"))}</h1>
<p>${escapeHtml(t("apply.success"))}</p>
<p class="muted">${escapeHtml(t("apply.privacyNote"))}</p>
</section>
<footer><a href="${escapeHtml(privacyUrl())}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("apply.privacyLink"))}</a></footer>`;
    return htmlResponse(pageShell(locale, t("apply.successTitle"), body));
}

function renderPage(options: {
    locale: Locale;
    t: TFunc;
    context: AppProxyContext;
    values: ApplicationValues;
    errors: ApplicationErrors;
    banner?: string;
}): string {
    const { locale, t, context, values, errors, banner } = options;
    const errorCount = Object.keys(errors).length;

    const banners = [
        banner
            ? `<div class="banner err" role="alert">${escapeHtml(banner)}</div>`
            : "",
        !banner && errorCount > 0
            ? `<div class="banner err" role="alert">${escapeHtml(t("apply.errorSummary"))}</div>`
            : "",
        context.loggedInCustomerId
            ? `<div class="banner info">${escapeHtml(t("apply.alreadyCustomer"))}</div>`
            : "",
    ].join("");

    const fields = APPLICATION_FIELDS.map((field) =>
        renderField(field, values, errors, locale, t),
    ).join("");

    const body = `<h1>${escapeHtml(t("apply.cta"))}</h1>
<p class="muted">${escapeHtml(t("apply.intro"))}</p>
<p class="note">${escapeHtml(t("apply.requiredNote"))}</p>
${banners}
<form method="post" action="${escapeHtml(APPLY_PATH)}" novalidate>
${fields}
<button type="submit">${escapeHtml(t("apply.submit"))}</button>
</form>
<footer>${escapeHtml(t("apply.privacyNote"))} <a href="${escapeHtml(privacyUrl())}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("apply.privacyLink"))}</a></footer>`;

    return pageShell(locale, t("apply.cta"), body);
}

/* ============================== 签名闸门 ============================== */

/** 校验 App Proxy 签名；非法时返回 401 响应，合法时返回 null（放行） */
function signatureGate(searchParams: URLSearchParams): Response | null {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!verifyAppProxySignature(searchParams, secret)) {
        // 只记事件与店铺，不打印 signature / secret（§8.2 D / §21.5）
        logStructured("warn", "appproxy.apply_rejected", {
            reason: "signature",
            shop: searchParams.get("shop") ?? undefined,
        });
        return unauthorized();
    }
    return null;
}

/* ============================== loader ============================== */

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const url = new URL(request.url);
    const rejected = signatureGate(url.searchParams);
    if (rejected) return rejected;

    const locale = localeFromRequest(request);
    const t = getT(locale);
    const context = readAppProxyContext(url.searchParams);

    return htmlResponse(
        renderPage({ locale, t, context, values: emptyValues(), errors: {} }),
    );
};

/* ============================== action ============================== */

export const action = async ({ request }: ActionFunctionArgs) => {
    const url = new URL(request.url);
    const rejected = signatureGate(url.searchParams);
    if (rejected) return rejected;

    const locale = localeFromRequest(request);
    const t = getT(locale);
    const context = readAppProxyContext(url.searchParams);

    const ip = clientIpFromHeaders(request.headers);
    if (!allowApplicationSubmission(context.shop, ip)) {
        logStructured("warn", "appproxy.apply_rejected", {
            reason: "rate_limited",
            shop: context.shop,
        });
        return htmlResponse(
            renderPage({
                locale,
                t,
                context,
                values: emptyValues(),
                errors: {},
                banner: t("error.applicationRateLimited"),
            }),
            429,
        );
    }

    const formData = await request.formData();
    const values = valuesFromFormData(formData);
    // 服务端二次校验：与前端同一份纯函数，前端被绕过也拦得住（§8.2 B）
    const { payload, errors } = validateApplication(values, locale);
    if (!payload) {
        return htmlResponse(
            renderPage({ locale, t, context, values, errors }),
            400,
        );
    }

    try {
        await createWholesaleApplication({
            shop: context.shop,
            payload,
            customerId: context.loggedInCustomerId,
        });
    } catch (error) {
        if (isTablelyError(error)) {
            return htmlResponse(
                renderPage({
                    locale,
                    t,
                    context,
                    values,
                    errors: { ...errors, [error.field ?? "email"]: error.key },
                }),
                400,
            );
        }
        logStructured("error", "appproxy.apply_failed", {
            shop: context.shop,
            reason: error instanceof Error ? error.name : "unknown",
        });
        return htmlResponse(
            renderPage({
                locale,
                t,
                context,
                values,
                errors: {},
                banner: t("error.saveFailed"),
            }),
            500,
        );
    }

    return successPage(locale, t);
};