import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import { getT, localeFromRequest } from "../i18n";
import { PRIVACY_UPDATED_AT, SUPPORT_EMAIL } from "../support";

/**
 * 公开隐私页 `/privacy`（Y11 / §8.3）
 *
 * 三条硬要求，本文件的结构性保证：
 *   ① **公开免鉴权**：**绝不**调用 `authenticate.admin`，也**不依赖 `shop` / `host` 参数**
 *      —— App Store 的 Privacy policy URL 直指本页，审核员与终端客户都要能打开（§8.3）；
 *   ② **不设置任何 cookie**：loader 只读请求头 / URL，不做任何写操作，也不碰 session；
 *      语言来自 `?locale=` 或 `Accept-Language`（无 cookie 回退，见 i18n.ts）；
 *   ③ **六模块与 §8.1 总表逐条对应**：收集 / 不收集 / 用途 / 保留期（90·180·30 天）/
 *      删除机制 / 子处理方与联系方式；文案全部走 i18n，7 语言无硬编码。
 *
 * 内容一致性由 `app/services/privacy.route.test.ts` 守住：逐语断言保留期数字，
 * 并静态断言本文件不含 `authenticate`（改 §8.1 必须同 PR 改本页，§8.3）。
 *
 * 样式沿用项目底线「美观大气 + 更好兼容」：rem 而非 px、系统色 + `color-mix` 派生灰度
 * 随浅深色自适应、逻辑属性（marginInline / paddingInlineStart / textAlign: start）兼容 RTL、
 * 不覆盖 outline 保留键盘焦点环、**不写 `!important`**。
 */
export const meta: MetaFunction = () => [
    { title: "Privacy policy — Tablely" },
    {
        name: "description",
        content:
            "What Tablely stores, what it does not store, how long data is kept and how it is deleted.",
    },
    // 公开页不进搜索引擎画像（与报价单页同一口径）
    { name: "robots", content: "noindex, nofollow" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
    // 只读：不读 cookie、不建 session、不触发鉴权跳转
    return { locale: localeFromRequest(request) };
};

const wrapStyle: React.CSSProperties = {
    colorScheme: "light dark",
    background: "canvas",
    color: "canvastext",
    maxWidth: "48rem",
    marginBlock: 0,
    marginInline: "auto",
    padding: "3rem 1.5rem 5rem",
    lineHeight: 1.75,
};

const h1Style: React.CSSProperties = {
    fontSize: "1.875rem",
    lineHeight: 1.3,
    margin: "0 0 0.5rem",
};

const h2Style: React.CSSProperties = {
    fontSize: "1.125rem",
    margin: "2rem 0 0.5rem",
};

const mutedStyle: React.CSSProperties = {
    color: "color-mix(in srgb, canvastext 65%, canvas)",
    fontSize: "0.8125rem",
};

const tableWrapStyle: React.CSSProperties = {
    overflowX: "auto",
    marginTop: "0.75rem",
};

const tableStyle: React.CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: "0.875rem",
};

const cellStyle: React.CSSProperties = {
    border: "1px solid color-mix(in srgb, canvastext 20%, canvas)",
    padding: "0.5rem 0.625rem",
    textAlign: "start",
    verticalAlign: "top",
};

const headCellStyle: React.CSSProperties = {
    ...cellStyle,
    background: "color-mix(in srgb, canvastext 6%, canvas)",
    fontWeight: 600,
};

export default function PrivacyPage() {
    const { locale } = useLoaderData<typeof loader>();
    const t = getT(locale);

    const rows = [
        {
            label: t("privacy.row.applications.label"),
            detail: t("privacy.row.applications.detail"),
            retention: t("privacy.row.applications.retention"),
        },
        {
            label: t("privacy.row.events.label"),
            detail: t("privacy.row.events.detail"),
            retention: t("privacy.row.events.retention"),
        },
        {
            label: t("privacy.row.quotes.label"),
            detail: t("privacy.row.quotes.detail"),
            retention: t("privacy.row.quotes.retention"),
        },
        {
            label: t("privacy.row.config.label"),
            detail: t("privacy.row.config.detail"),
            retention: t("privacy.row.config.retention"),
        },
    ];

    return (
        <main style={wrapStyle} lang={locale}>
            <h1 style={h1Style}>{t("privacy.title")}</h1>
            <p style={mutedStyle}>{t("privacy.updated", { date: PRIVACY_UPDATED_AT })}</p>

            <p>{t("privacy.intro")}</p>

            <h2 style={h2Style}>{t("privacy.s1.title")}</h2>
            <p>{t("privacy.s1.merchant")}</p>
            <p>{t("privacy.s1.customer")}</p>

            <h2 style={h2Style}>{t("privacy.s2.title")}</h2>
            <p>{t("privacy.s2.body")}</p>

            <h2 style={h2Style}>{t("privacy.s3.title")}</h2>
            <p>{t("privacy.s3.body")}</p>

            <h2 style={h2Style}>{t("privacy.s4.title")}</h2>
            <p>{t("privacy.s4.body")}</p>
            <div style={tableWrapStyle}>
                <table style={tableStyle}>
                    <thead>
                        <tr>
                            <th scope="col" style={headCellStyle}>
                                {t("privacy.col.data")}
                            </th>
                            <th scope="col" style={headCellStyle}>
                                {t("privacy.col.detail")}
                            </th>
                            <th scope="col" style={headCellStyle}>
                                {t("privacy.col.retention")}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.label}>
                                <th scope="row" style={cellStyle}>
                                    {row.label}
                                </th>
                                <td style={cellStyle}>{row.detail}</td>
                                <td style={cellStyle}>{row.retention}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <h2 style={h2Style}>{t("privacy.s5.title")}</h2>
            <p>{t("privacy.s5.body")}</p>

            <h2 style={h2Style}>{t("privacy.s6.title")}</h2>
            <p>{t("privacy.s6.body")}</p>
            <p>
                <a href={`mailto:${SUPPORT_EMAIL}`}>
                    {t("privacy.contact", { email: SUPPORT_EMAIL })}
                </a>
            </p>
        </main>
    );
}
