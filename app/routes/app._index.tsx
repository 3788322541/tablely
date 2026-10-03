import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest, type Locale } from "../i18n";

/**
 * Overview（M1 占位）
 *
 * 方案里的完整 Overview（激活引导清单 / 统计 / 空态）在 M14 实现。
 * M1 只保证「登录后能落到一个真实页面」，因此这里只有标题与一句说明。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    await authenticate.admin(request);
    return { locale: localeFromRequest(request) };
};

export default function OverviewPage() {
    const { locale } = useLoaderData<typeof loader>();
    const t = getT(locale as Locale);

    return (
        <s-page heading={t("overview.title")}>
            <s-section>
                <s-paragraph>{t("overview.placeholder")}</s-paragraph>
            </s-section>
        </s-page>
    );
}