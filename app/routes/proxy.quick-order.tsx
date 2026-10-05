import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { getT, localeFromRequest, type Locale, type TFunc } from "../i18n";
import { QUICK_ORDER_MAX_LINES } from "../perf-limits";
import { hasFeature } from "../plan";
import {
    QUICK_ORDER_PATH,
    allowQuickOrderSubmission,
    clientIpFromHeaders,
    readAppProxyContext,
    type AppProxyContext,
} from "../services/appProxy.server";
import { getShopInfo, type GraphqlAdmin } from "../services/metafield.server";
import { logStructured } from "../services/monitor.server";
import {
    escapeHtml,
    htmlResponse,
    pageShell,
    privacyUrl,
    signatureGate,
} from "../services/proxyPage.server";
import {
    parseCsvList,
    parsePasteList,
    resolveHistoryQuickOrder,
    resolveQuickOrder,
    truncateToLimit,
    type QuickOrderLine,
    type QuickOrderResult,
} from "../services/quickOrder.server";
import { recentAddToCartLines } from "../services/reorder.server";
import { resolvePlan } from "../services/tables.server";
import { unauthenticated } from "../shopify.server";

/**
 * 快速补货落脚页（M13 / B3 / §15.4）—— **App Proxy 回源页**
 *
 * 顾客访问 `https://<shop>/apps/tablely/quick-order`，Shopify 转发 + 签名到本路由
 * （`[app_proxy] url = .../proxy` → 本文件 = `/proxy/quick-order`）。
 *
 * 三条输入路径，殊途同归成同一张可加购的订购表：
 *   ① 粘贴 SKU 清单（`SKU,数量` 每行一条）；
 *   ② 上传 CSV（列按名定位，必须有 `sku` 列）；
 *   ③ 历史加购再下单（Pro，需登录：读本应用自己的 `AddToCartEvent`，§15.7）。
 *
 * 硬约束：
 *   · **不做批发门控**（否则非批发客户连页都看不到，§15.4）—— 但**整页属 Pro 功能**（#22），
 *     Free 档只展示 `quickOrder.proRequired`，不渲染任何表单；
 *   · **P8 上限**：清单 ≤ 50 行，超出明确提示（`quickOrder.lineLimit`）；
 *   · **未匹配 SKU 明确列出**（`quickOrder.unmatched`），不静默丢弃；
 *   · 加购走与商品页**同一套 `/cart/add` + `api.addtocart` 上报**，行为一致；
 *   · 非 Admin 上下文 → 只校验 App Proxy 签名（失败 401）；取价 / 匹配用
 *     `unauthenticated.admin(shop)` 走已存的 offline 会话。
 */

/* ============================== 视图状态 ============================== */

type QuickOrderSource = "none" | "paste" | "csv" | "history";

type ViewState = {
    source: QuickOrderSource;
    result: QuickOrderResult;
    /** 逐行失败提示（粘贴：原行文本；CSV：`line N`） */
    invalid: string[];
    /** CSV 整体错误（列头缺失等） */
    headerError: string | null;
    overLimit: boolean;
    /** 历史路径：已登录但无记录 */
    historyEmpty: boolean;
};

const EMPTY_RESULT: QuickOrderResult = {
    lines: [],
    unmatched: [],
    overLimit: false,
    mixHint: null,
};

function initialState(): ViewState {
    return {
        source: "none",
        result: EMPTY_RESULT,
        invalid: [],
        headerError: null,
        overLimit: false,
        historyEmpty: false,
    };
}

/* ============================== 渲染工具 ============================== */

/** 金额格式化（店铺本位币 + 请求语言，与打印视图同源） */
function moneyFormatter(locale: Locale, currency: string): (cents: number) => string {
    try {
        const formatter = new Intl.NumberFormat(locale, {
            style: "currency",
            currency,
        });
        return (cents) => formatter.format(cents / 100);
    } catch {
        return (cents) => (cents / 100).toFixed(2);
    }
}

/** 档位预览（`Buy N+ for X each`；price 档才可展示，percent 档交给混单提示） */
function tiersLine(t: TFunc, line: QuickOrderLine, format: (cents: number) => string): string {
    const parts: string[] = [];
    for (const tier of line.tiers) {
        if (tier.price !== undefined) {
            const cents = Math.round((Number.parseFloat(tier.price) || 0) * 100);
            parts.push(t("tier.label", { n: tier.qty, price: format(cents) }));
        } else if (tier.percent !== undefined) {
            parts.push(`-${tier.percent}%`);
        }
    }
    return parts.length ? escapeHtml(parts.join(" · ")) : "";
}

function sourceKey(source: QuickOrderSource): string {
    if (source === "csv") return "csv";
    if (source === "history") return "reorder";
    return "table";
}

/** 表单区（粘贴 / CSV / 历史） */
function inputSections(options: {
    t: TFunc;
    context: AppProxyContext;
}): string {
    const { t, context } = options;
    const paste = `<form method="post" action="${escapeHtml(QUICK_ORDER_PATH)}" class="card">
<h2>${escapeHtml(t("quickOrder.pasteLabel"))}</h2>
<div class="field">
<label for="qo-skus">${escapeHtml(t("quickOrder.pasteHint"))}</label>
<textarea id="qo-skus" name="skus" placeholder="SKU-001,10&#10;SKU-002,5"></textarea>
</div>
<input type="hidden" name="intent" value="paste" />
<button type="submit">${escapeHtml(t("quickOrder.build"))}</button>
</form>`;

    const csv = `<form method="post" action="${escapeHtml(QUICK_ORDER_PATH)}" class="card" enctype="multipart/form-data">
<h2>${escapeHtml(t("quickOrder.csvLabel"))}</h2>
<div class="field">
<label for="qo-file">${escapeHtml(t("quickOrder.csvHint"))}</label>
<input id="qo-file" type="file" name="file" accept=".csv,text/csv" />
</div>
<input type="hidden" name="intent" value="csv" />
<button type="submit">${escapeHtml(t("quickOrder.csvUpload"))}</button>
</form>`;

    const history = context.loggedInCustomerId
        ? `<form method="post" action="${escapeHtml(QUICK_ORDER_PATH)}" class="card">
<h2>${escapeHtml(t("quickOrder.historyTitle"))}</h2>
<p class="muted">${escapeHtml(t("quickOrder.historyLimit", { n: QUICK_ORDER_MAX_LINES }))}</p>
<input type="hidden" name="intent" value="history" />
<button type="submit">${escapeHtml(t("quickOrder.historyUse"))}</button>
</form>`
        : `<section class="card">
<h2>${escapeHtml(t("quickOrder.historyTitle"))}</h2>
<p class="muted">${escapeHtml(t("quickOrder.historySignedOut"))}</p>
</section>`;

    return `${paste}${csv}${history}`;
}

/** 结果表 + 加购表单（原生 `/cart/add`，无 JS 也能提交） */
function resultSection(options: {
    t: TFunc;
    lines: QuickOrderLine[];
    format: (cents: number) => string;
}): string {
    const { t, lines, format } = options;
    const totalCents = lines.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);

    const rows = lines
        .map((line, index) => {
            const title = line.variantTitle && line.variantTitle !== "Default Title"
                ? `${line.productTitle} — ${line.variantTitle}`
                : line.productTitle || line.sku;
            const tiers = tiersLine(t, line, format);
            const max = line.max === null ? "" : ` max="${line.max}"`;
            return `<tr data-line="${index}">
<td>
<input type="hidden" name="items[${index}][id]" value="${escapeHtml(line.variantId)}" />
<span data-title>${escapeHtml(title)}</span>
${tiers ? `<div class="muted">${tiers}</div>` : ""}
</td>
<td>${escapeHtml(line.sku)}</td>
<td class="qty">
<input type="number" name="items[${index}][quantity]" value="${line.quantity}" min="${line.min}"${max} step="${line.step}" data-variant-id="${escapeHtml(line.variantId)}" data-product-id="${escapeHtml(line.productId)}" aria-label="${escapeHtml(t("quickOrder.quantity"))}" />
</td>
<td><button type="button" class="link" data-remove>${escapeHtml(t("quickOrder.remove"))}</button></td>
</tr>`;
        })
        .join("");

    return `<form method="post" action="/cart/add" data-qo-form>
<h2>${escapeHtml(t("quickOrder.heading"))}</h2>
<table>
<thead><tr>
<th>${escapeHtml(t("quickOrder.colProduct"))}</th>
<th>SKU</th>
<th>${escapeHtml(t("quickOrder.colQty"))}</th>
<th></th>
</tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="2">${escapeHtml(t("quote.total"))}</td><td colspan="2" data-qo-total>${escapeHtml(format(totalCents))}</td></tr></tfoot>
</table>
<button type="submit">${escapeHtml(t("quickOrder.addAll"))}</button>
</form>`;
}

/** 页内脚本配置（与店面 `tablely.js` 的 `reportAddToCart` 同契约） */
function inlineConfig(options: {
    shop: string;
    reportUrl: string;
    customerId: string | null;
    source: QuickOrderSource;
}): string {
    const payload = {
        shop: options.shop,
        reportUrl: options.reportUrl,
        customerId: options.customerId ?? "",
        source: sourceKey(options.source),
    };
    const json = JSON.stringify(payload).replace(/</g, "\\u003c");
    return `<script>window.__tablelyQuickOrder=${json};</script>
<script>
(function () {
  var form = document.querySelector('[data-qo-form]');
  var cfg = window.__tablelyQuickOrder || {};
  if (!form) return;

  function reindex() {
    var rows = form.querySelectorAll('tr[data-line]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('data-line', String(i));
      var id = rows[i].querySelector('input[name$="[id]"]');
      var qty = rows[i].querySelector('input[name$="[quantity]"]');
      if (id) id.name = 'items[' + i + '][id]';
      if (qty) qty.name = 'items[' + i + '][quantity]';
    }
  }

  form.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== form && !(target.getAttribute && target.getAttribute('data-remove') !== null)) {
      target = target.parentNode;
    }
    if (target && target !== form && target.getAttribute('data-remove') !== null) {
      var row = target.parentNode;
      while (row && row.tagName !== 'TR') row = row.parentNode;
      if (row) row.parentNode.removeChild(row);
      reindex();
      event.preventDefault();
    }
  });

  form.addEventListener('submit', function () {
    if (!cfg.reportUrl) return;
    var rows = form.querySelectorAll('tr[data-line]');
    var total = rows.length;
    var messages = [];
    for (var i = 0; i < rows.length; i++) {
      var qtyInput = rows[i].querySelector('input[name$="[quantity]"]');
      var qty = qtyInput ? parseInt(qtyInput.value, 10) : 0;
      if (!isFinite(qty) || qty < 1) continue;
      messages.push(JSON.stringify({
        shop: cfg.shop,
        productId: qtyInput.getAttribute('data-product-id'),
        variantId: qtyInput.getAttribute('data-variant-id'),
        quantity: qty,
        rows: total,
        source: cfg.source,
        customerId: cfg.customerId
      }));
    }
    for (var j = 0; j < messages.length; j++) {
      var text = messages[j];
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(cfg.reportUrl, new Blob([text], { type: 'text/plain' }));
        } else {
          fetch(cfg.reportUrl, { method: 'POST', body: text, headers: { 'content-type': 'text/plain' }, keepalive: true });
        }
      } catch (error) { /* 上报失败绝不影响加购 */ }
    }
  });
})();
</script>`;
}

/* ============================== 页面 ============================== */

function renderPage(options: {
    locale: Locale;
    t: TFunc;
    context: AppProxyContext;
    pro: boolean;
    state: ViewState;
    currency: string;
    reportUrl: string;
    errorKey: string | null;
}): string {
    const { locale, t, context, pro, state, currency, reportUrl, errorKey } = options;
    const format = moneyFormatter(locale, currency);

    const heading = `<h1>${escapeHtml(t("quickOrder.heading"))}</h1>`;
    const footer = `<footer>${escapeHtml(t("quickOrder.limitation"))} · <a href="${escapeHtml(privacyUrl())}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("apply.privacyLink"))}</a></footer>`;

    if (!pro) {
        return pageShell({
            locale,
            title: t("quickOrder.heading"),
            body: `${heading}<div class="banner err" role="alert">${escapeHtml(t("quickOrder.proRequired"))}</div>${footer}`,
        });
    }

    const banners: string[] = [];
    if (errorKey) {
        banners.push(`<div class="banner err" role="alert">${escapeHtml(t(errorKey))}</div>`);
    }
    if (state.headerError) {
        banners.push(`<div class="banner err" role="alert">${escapeHtml(t(state.headerError))}</div>`);
    }
    if (state.overLimit) {
        banners.push(
            `<div class="banner warn" role="status">${escapeHtml(t("quickOrder.lineLimit", { n: QUICK_ORDER_MAX_LINES }))}</div>`,
        );
    }
    if (state.invalid.length) {
        banners.push(
            `<div class="banner err" role="alert">${escapeHtml(t("quickOrder.invalidSku"))}<ul class="plain">${state.invalid
                .map((line) => `<li>${escapeHtml(line)}</li>`)
                .join("")}</ul></div>`,
        );
    }
    if (state.result.unmatched.length) {
        banners.push(
            `<div class="banner warn" role="alert">${escapeHtml(t("quickOrder.unmatched", { n: state.result.unmatched.length }))}<ul class="plain">${state.result.unmatched
                .map((sku) => `<li>${escapeHtml(sku)}</li>`)
                .join("")}</ul></div>`,
        );
    }
    if (state.result.mixHint) {
        banners.push(
            `<div class="banner info" role="status">${escapeHtml(t("mixmatch.hint", { n: state.result.mixHint.n, percent: state.result.mixHint.percent }))}</div>`,
        );
    }
    if (state.historyEmpty) {
        banners.push(
            `<div class="banner" role="status">${escapeHtml(t("quickOrder.historyEmpty"))}</div>`,
        );
    }

    const hasLines = state.result.lines.length > 0;
    const empty =
        !hasLines && state.source === "none"
            ? `<p class="note">${escapeHtml(t("quickOrder.empty"))}</p>`
            : "";

    const result = hasLines ? resultSection({ t, lines: state.result.lines, format }) : "";

    const quoteCard = `<section class="card">
<h2>${escapeHtml(t("quickOrder.quoteCta"))}</h2>
<p class="muted">${escapeHtml(t("quickOrder.quoteHint"))}</p>
</section>`;

    const body = `${heading}
${banners.join("")}
${empty}
${result}
${inputSections({ t, context })}
${quoteCard}
${inlineConfig({ shop: context.shop, reportUrl, customerId: context.loggedInCustomerId, source: state.source })}
${footer}`;

    return pageShell({ locale, title: t("quickOrder.heading"), body });
}

/* ============================== Admin 客户端 ============================== */

/** 无 Admin 上下文 → 用已存 offline 会话取 admin（无会话返回 null，页面降级为提示） */
async function adminForShop(shop: string): Promise<GraphqlAdmin | null> {
    try {
        const { admin } = await unauthenticated.admin(shop);
        return admin;
    } catch (error) {
        logStructured("warn", "appproxy.quick_order_no_session", {
            shop,
            reason: error instanceof Error ? error.name : "unknown",
        });
        return null;
    }
}

/* ============================== loader ============================== */

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const url = new URL(request.url);
    const rejected = signatureGate(url.searchParams, "appproxy.quick_order_rejected");
    if (rejected) return rejected;

    const locale = localeFromRequest(request);
    const t = getT(locale);
    const context = readAppProxyContext(url.searchParams);

    const plan = await resolvePlan(context.shop);
    const pro = hasFeature(plan, "quick_order");

    let currency = "USD";
    let reportUrl = "";
    let errorKey: string | null = null;
    if (pro) {
        const admin = await adminForShop(context.shop);
        if (admin) {
            try {
                currency = (await getShopInfo(admin)).currencyCode;
            } catch {
                /* 币种取不到就用默认，不影响补货 */
            }
            reportUrl = `${(process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "")}/api/addtocart`;
        } else {
            errorKey = "quickOrder.error";
        }
    }

    return htmlResponse(
        renderPage({
            locale,
            t,
            context,
            pro,
            state: initialState(),
            currency,
            reportUrl,
            errorKey,
        }),
    );
};

/* ============================== action ============================== */

export const action = async ({ request }: ActionFunctionArgs) => {
    const url = new URL(request.url);
    const rejected = signatureGate(url.searchParams, "appproxy.quick_order_rejected");
    if (rejected) return rejected;

    const locale = localeFromRequest(request);
    const t = getT(locale);
    const context = readAppProxyContext(url.searchParams);

    const plan = await resolvePlan(context.shop);
    const pro = hasFeature(plan, "quick_order");
    if (!pro) {
        return htmlResponse(
            renderPage({
                locale,
                t,
                context,
                pro: false,
                state: initialState(),
                currency: "USD",
                reportUrl: "",
                errorKey: null,
            }),
            403,
        );
    }

    const ip = clientIpFromHeaders(request.headers);
    if (!allowQuickOrderSubmission(context.shop, ip)) {
        logStructured("warn", "appproxy.quick_order_rejected", {
            reason: "rate_limited",
            shop: context.shop,
        });
        return htmlResponse(
            renderPage({
                locale,
                t,
                context,
                pro: true,
                state: initialState(),
                currency: "USD",
                reportUrl: "",
                errorKey: "error.applicationRateLimited",
            }),
            429,
        );
    }

    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "paste");
    const state = initialState();

    const admin = await adminForShop(context.shop);
    if (!admin) {
        return htmlResponse(
            renderPage({
                locale,
                t,
                context,
                pro: true,
                state,
                currency: "USD",
                reportUrl: "",
                errorKey: "quickOrder.error",
            }),
            200,
        );
    }

    let currency = "USD";
    try {
        currency = (await getShopInfo(admin)).currencyCode;
    } catch {
        /* 币种取不到就用默认 */
    }
    const reportUrl = `${(process.env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "")}/api/addtocart`;

    try {
        if (intent === "csv") {
            state.source = "csv";
            const file = formData.get("file");
            if (!(file instanceof File) || file.size === 0) {
                state.headerError = "csv.empty";
            } else {
                const parsed = parseCsvList(await file.text());
                state.headerError = parsed.error;
                state.invalid = parsed.invalid.map((row) => `${row.sku || "—"}${row.line ? ` (line ${row.line})` : ""}`);
                const limited = truncateToLimit(parsed.rows);
                state.overLimit = limited.overLimit;
                state.result = await resolveQuickOrder({
                    admin,
                    shop: context.shop,
                    requested: limited.rows,
                });
            }
        } else if (intent === "history") {
            state.source = "history";
            const customerId = context.loggedInCustomerId;
            if (!customerId) {
                state.headerError = null;
                state.historyEmpty = false;
                state.result = EMPTY_RESULT;
                // 未登录：不查询（按钮本就不显示），直接空态
            } else {
                const history = await recentAddToCartLines({
                    shop: context.shop,
                    customerId,
                });
                if (history.length === 0) {
                    state.historyEmpty = true;
                } else {
                    const limited = truncateToLimit(history);
                    state.overLimit = limited.overLimit;
                    state.result = await resolveHistoryQuickOrder({
                        admin,
                        shop: context.shop,
                        history: limited.rows,
                    });
                }
            }
        } else {
            state.source = "paste";
            const parsed = parsePasteList(String(formData.get("skus") ?? ""));
            state.invalid = parsed.invalid;
            const limited = truncateToLimit(parsed.rows);
            state.overLimit = limited.overLimit;
            state.result = await resolveQuickOrder({
                admin,
                shop: context.shop,
                requested: limited.rows,
            });
        }
    } catch (error) {
        logStructured("error", "appproxy.quick_order_failed", {
            shop: context.shop,
            reason: error instanceof Error ? error.name : "unknown",
        });
        return htmlResponse(
            renderPage({
                locale,
                t,
                context,
                pro: true,
                state: initialState(),
                currency,
                reportUrl,
                errorKey: "quickOrder.error",
            }),
            500,
        );
    }

    return htmlResponse(
        renderPage({ locale, t, context, pro: true, state, currency, reportUrl, errorKey: null }),
    );
};