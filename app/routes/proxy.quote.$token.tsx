import type { LoaderFunctionArgs } from "react-router";

import { getT, localeFromRequest, type Locale, type TFunc } from "../i18n";
import { readAppProxyContext } from "../services/appProxy.server";
import {
    escapeHtml,
    htmlResponse,
    pageShell,
    privacyUrl,
    signatureGate,
} from "../services/proxyPage.server";
import {
    canViewWholesale,
    getQuoteByToken,
    isQuoteActive,
    quoteNumber,
    type QuoteLine,
    type QuoteRecord,
} from "../services/quotes.server";

/**
 * 报价单打印视图（M13 / Y17 / §15.8.3）—— **App Proxy 回源页**
 *
 * 顾客访问 `https://<shop>/apps/tablely/quote/<token>`，Shopify 转发 + 签名到本路由。
 *
 * 两条硬约束：
 *   · **不生成 PDF 文件**（不引入 PDF 库、不用无头 Chrome，§15.8.1）—— 输出**专供打印的
 *     HTML**（`@media print` A4），页面一个「打印 / 另存为 PDF」按钮调 `window.print()`；
 *   · **红线：专属价绝不匿名暴露**（§15.8.2）—— 匿名 token 只渲染**公开阶梯价**；
 *     仅当「本报价单挂了目标客户」且「当前登录客户 id 与之完全一致」时才展示批发价，
 *     其余情况（未登录 / 不匹配）**降级为公开档位**，不报错也不泄露。
 *
 * 报价价格是**生成时刻冻结的快照**（§15.8.4），本页**不调 Admin API 实时取价**。
 */

/* ============================== 渲染工具 ============================== */

function moneyFormatter(locale: Locale, currency: string): (cents: number) => string {
    try {
        const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
        return (cents) => formatter.format(cents / 100);
    } catch {
        return (cents) => (cents / 100).toFixed(2);
    }
}

/** 档位预览：`price` 档显示 `Buy N+ for X each`，`percent` 档显示 `-N%` */
function tiersText(line: QuoteLine, format: (cents: number) => string, t: TFunc): string {
    const parts: string[] = [];
    for (const tier of line.tiers) {
        if (tier.price !== undefined) {
            const cents = Math.round((Number.parseFloat(tier.price) || 0) * 100);
            parts.push(t("tier.label", { n: tier.qty, price: format(cents) }));
        } else if (tier.percent !== undefined) {
            parts.push(`-${tier.percent}%`);
        }
    }
    return parts.join(" · ");
}

/** 打印专用样式：A4、隐藏交互元素、防表格断行（§15.8.1） */
const PRINT_STYLES = `
.no-print{margin:0 0 18px}
.quote-head{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:flex-start;margin:0 0 8px}
.quote-shop{font-weight:700;font-size:1.05rem}
.meta{margin:0 0 20px;font-size:.88rem;color:var(--muted)}
.meta span{display:inline-block;margin-right:18px}
@media print{
  :root{color-scheme:light}
  body{background:#fff;color:#000}
  .wrap{max-width:none;padding:0}
  .no-print{display:none}
  footer{color:#000}
  th{color:#000}
  tr,.card{page-break-inside:avoid}
  @page{size:A4;margin:14mm}
}
`;

/* ============================== 页面 ============================== */

function renderInvalid(options: { locale: Locale; t: TFunc; messageKey: string }): Response {
    const { locale, t, messageKey } = options;
    const body = `<h1>${escapeHtml(t("quote.title"))}</h1>
<div class="banner err" role="alert">${escapeHtml(t(messageKey))}</div>`;
    return htmlResponse(pageShell({ locale, title: t("quote.title"), body }), 404);
}

function renderQuote(options: {
    locale: Locale;
    t: TFunc;
    quote: QuoteRecord;
    showWholesale: boolean;
}): Response {
    const { locale, t, quote, showWholesale } = options;
    const format = moneyFormatter(locale, quote.currency);
    const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

    const heading = quote.title?.trim() ? quote.title.trim() : t("quote.title");

    const rows = quote.lines
        .map((line) => {
            const unit = showWholesale && line.wholesale !== undefined ? line.wholesale : line.unitPrice;
            const amount = unit * line.qty;
            const tiers = tiersText(line, format, t);
            return `<tr>
<td>${escapeHtml(line.title || line.sku)}${tiers ? `<div class="muted">${escapeHtml(tiers)}</div>` : ""}</td>
<td>${escapeHtml(line.sku)}</td>
<td>${line.qty}</td>
<td>${escapeHtml(format(unit))}</td>
<td>${escapeHtml(format(amount))}</td>
</tr>`;
        })
        .join("");

    const total = quote.lines.reduce((sum, line) => {
        const unit = showWholesale && line.wholesale !== undefined ? line.wholesale : line.unitPrice;
        return sum + unit * line.qty;
    }, 0);

    const banners: string[] = [];
    if (quote.customerId && !showWholesale) {
        // 登录但不匹配 / 未登录：降级为公开档位，不报错（§15.8.2）
        banners.push(`<div class="banner" role="status">${escapeHtml(t("quote.anonNote"))}</div>`);
    }
    if (showWholesale) {
        banners.push(
            `<div class="banner warn" role="status">${escapeHtml(t("quote.confidential"))}</div>`,
        );
    }

    const meta = `<div class="meta">
<span>${escapeHtml(t("quote.number"))}: ${escapeHtml(quoteNumber(quote.token))}</span>
<span>${escapeHtml(t("quote.issued"))}: ${escapeHtml(dateFormat.format(quote.createdAt))}</span>
<span>${escapeHtml(t("quote.validUntil", { date: dateFormat.format(quote.validUntil) }))}</span>
${quote.customerId ? `<span>${escapeHtml(t("quote.customer"))}: ${escapeHtml(quote.customerId)}</span>` : ""}
</div>`;

    const note = quote.note?.trim()
        ? `<section class="card"><h2>${escapeHtml(t("quote.note"))}</h2><p>${escapeHtml(quote.note.trim()).replace(/\n/g, "<br />")}</p></section>`
        : "";

    const body = `<div class="quote-head">
<div><div class="quote-shop">${escapeHtml(quote.shop)}</div><h1>${escapeHtml(heading)}</h1></div>
</div>
<button type="button" class="no-print" onclick="window.print()">${escapeHtml(t("quote.print"))}</button>
${meta}
${banners.join("")}
<table>
<thead><tr>
<th>${escapeHtml(t("quote.col.item"))}</th>
<th>${escapeHtml(t("quote.col.sku"))}</th>
<th>${escapeHtml(t("quote.col.qty"))}</th>
<th>${escapeHtml(t("quote.col.unitPrice"))}</th>
<th>${escapeHtml(t("quote.col.amount"))}</th>
</tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="4">${escapeHtml(t("quote.total"))}</td><td>${escapeHtml(format(total))}</td></tr></tfoot>
</table>
${note}
<footer>
<p>${escapeHtml(t("quote.taxNote"))} · ${escapeHtml(t("quote.currency", { code: quote.currency }))}</p>
<p>${escapeHtml(t("quote.disclaimer"))} · ${escapeHtml(t("quote.validUntil", { date: dateFormat.format(quote.validUntil) }))}</p>
<p><a href="${escapeHtml(privacyUrl())}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("apply.privacyLink"))}</a></p>
</footer>`;

    return htmlResponse(
        pageShell({
            locale,
            title: heading,
            body,
            styles: PRINT_STYLES,
        }),
    );
}

/* ============================== loader ============================== */

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
    const url = new URL(request.url);
    const rejected = signatureGate(url.searchParams, "appproxy.quote_rejected");
    if (rejected) return rejected;

    const locale = localeFromRequest(request);
    const t = getT(locale);
    const context = readAppProxyContext(url.searchParams);
    const token = String(params.token ?? "").trim();

    const quote = context.shop && token ? await getQuoteByToken(context.shop, token) : null;
    if (!quote) return renderInvalid({ locale, t, messageKey: "quote.invalid" });
    if (quote.revoked) return renderInvalid({ locale, t, messageKey: "quote.revoked" });
    if (!isQuoteActive(quote)) return renderInvalid({ locale, t, messageKey: "quote.invalid" });

    const showWholesale = canViewWholesale(quote, context.loggedInCustomerId);
    return renderQuote({ locale, t, quote, showWholesale });
};