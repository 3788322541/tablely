import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureTablelySetup } from "../services/settings.server";
import { getT, localeFromRequest, type Locale } from "../i18n";

/**
 * Overview（M1 占位）
 *
 * 方案里的完整 Overview（激活引导清单 / 统计 / 空态）在 M14 实现。
 * M1 只保证「登录后能落到一个真实页面」，因此这里只有标题与一句说明。
 *
 * M4 起这里额外承担**安装自愈兜底**：`afterAuth` 的播种若失败（或历史店铺缺配置），
 * 商家只要打开后台就会重跑同一套幂等流程（建定义 → 播种设置行 → 下发 metafield）。
 * 失败只记日志，不阻塞页面 —— 后台能用比配置齐全更重要。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    try {
        await ensureTablelySetup({ admin, shop: session.shop });
    } catch (error) {
        console.error("[tablely] Overview 安装自愈失败:", error);
    }
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