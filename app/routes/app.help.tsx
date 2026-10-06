import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { APP_VERSION } from "../services/monitor.server";
import { SUPPORT_EMAIL } from "../support";

/**
 * Help（M15 / §十二 验收 20）
 *
 * 一页说清「怎么把订购表放上店铺 + 常见问题 + 出问题找谁」，覆盖方案 A5：
 *   · 放 App Block 的三步（主题编辑器路径 + 启用商品），并标明禁用 JS 时的行为（§2.8 约束 6）；
 *   · 门控 / 阶梯价 / 已知局限（与 §8.1 保留期、§5.1 结算价口径一致，不写「什么都支持」）；
 *   · FAQ 5 条（对应验收 20），支持邮箱与响应时效（Free / Pro 区分）；
 *   · 底部链到公开隐私页 `/privacy`（§8.3 入口四处之一）。
 *
 * 版本号由 loader 从 `monitor.server` 的 `APP_VERSION` 读入 —— 客户端组件不直接
 * import 服务端模块，避免 `Server-only module referenced by client`（贡献者约定）。
 * 文案全部走 i18n，7 语言无硬编码（scripts/check-i18n.ts 守 key parity）。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    await authenticate.admin(request);
    return { locale: localeFromRequest(request), version: APP_VERSION };
};

export default function HelpPage() {
    const { locale, version } = useLoaderData<typeof loader>();
    const t = getT(locale);

    const installSteps = [
        t("help.install.step1"),
        t("help.install.step2"),
        t("help.install.step3"),
    ];

    const limits = [
        t("help.limits.nojs"),
        t("help.limits.history"),
        t("help.limits.quote"),
    ];

    const faqs = [1, 2, 3, 4, 5].map((index) => ({
        question: t(`help.faq.q${index}`),
        answer: t(`help.faq.a${index}`),
    }));

    return (
        <s-page heading={t("help.title")}>
            <s-section>
                <s-text color="subdued">{t("help.intro")}</s-text>
            </s-section>

            <s-section heading={t("help.install.title")}>
                <s-stack direction="block" gap="base">
                    <s-unordered-list>
                        {installSteps.map((step) => (
                            <s-list-item key={step}>{step}</s-list-item>
                        ))}
                    </s-unordered-list>
                    <s-text color="subdued">{t("help.install.note")}</s-text>
                </s-stack>
            </s-section>

            <s-section heading={t("help.gating.title")}>
                <s-paragraph>{t("help.gating.body")}</s-paragraph>
            </s-section>

            <s-section heading={t("help.tiers.title")}>
                <s-paragraph>{t("help.tiers.body")}</s-paragraph>
            </s-section>

            <s-section heading={t("help.limits.title")}>
                <s-unordered-list>
                    {limits.map((item) => (
                        <s-list-item key={item}>{item}</s-list-item>
                    ))}
                </s-unordered-list>
            </s-section>

            <s-section heading={t("help.faq.title")}>
                <s-stack direction="block" gap="base">
                    {faqs.map((faq) => (
                        <s-stack key={faq.question} direction="block" gap="small">
                            <s-heading>{faq.question}</s-heading>
                            <s-paragraph>{faq.answer}</s-paragraph>
                        </s-stack>
                    ))}
                </s-stack>
            </s-section>

            <s-section heading={t("help.support.title")}>
                <s-stack direction="block" gap="base">
                    <s-paragraph>
                        {t("help.support.body", { email: SUPPORT_EMAIL })}
                    </s-paragraph>
                    <s-link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</s-link>
                    <s-text color="subdued">{t("help.support.pro")}</s-text>
                </s-stack>
            </s-section>

            <s-section heading={t("help.changelog.title")}>
                <s-paragraph>{t("help.changelog.body", { version })}</s-paragraph>
            </s-section>

            <s-section>
                <s-link href="/privacy" target="_blank">
                    {t("help.privacy")}
                </s-link>
            </s-section>
        </s-page>
    );
}
