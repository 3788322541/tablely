import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureTablelySetup } from "../services/settings.server";
import { getWinbackSummary, markWinbackSeen, readPlanStatus } from "../services/billing.server";
import { getT, localeFromRequest, type Locale } from "../i18n";

/**
 * Overview（M1 占位；M9 承接试用挽回触点 ①②）
 *
 * 方案里的完整 Overview（激活引导清单 / 统计 / 空态）在 M14 实现。
 * M9 只补两块与订阅直接相关的应用内提示（§19.4，**非弹窗**）：
 *   ① 试用将尽（剩余 1–2 天）→ 顶部提示条 + 升级入口；
 *   ② 降级后首次打开后台 → 一张「说明卡」（winback.summary），逐条说清代价，
 *      主按钮「恢复 Pro」、次按钮「先按 Free 用」（关闭后不再提示）。
 *
 * M4 起这里额外承担**安装自愈兜底**：`afterAuth` 的播种若失败（或历史店铺缺配置），
 * 商家只要打开后台就会重跑同一套幂等流程。失败只记日志，不阻塞页面。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    try {
        await ensureTablelySetup({ admin, shop: session.shop });
    } catch (error) {
        console.error("[tablely] Overview 安装自愈失败:", error);
    }

    const [plan, winback] = await Promise.all([
        readPlanStatus(session.shop),
        getWinbackSummary(session.shop),
    ]);

    return { locale: localeFromRequest(request), plan, winback };
};

export const action = async ({ request }: ActionFunctionArgs) => {
    const { session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "");
    if (intent === "dismiss-winback") {
        await markWinbackSeen(session.shop);
        return { ok: true as const, intent };
    }
    return { ok: false as const, intent };
};

export default function OverviewPage() {
    const { locale, plan, winback } = useLoaderData<typeof loader>();
    const t = getT(locale as Locale);
    const fetcher = useFetcher<typeof action>();

    return (
        <s-page heading={t("overview.title")}>
            {/* ① 试用将尽提示条：只在剩余 1–2 天出现，非弹窗 */}
            {plan.trialEndingSoon && plan.trialDaysLeft !== null ? (
                <s-section>
                    <s-banner
                        tone="warning"
                        heading={t("trial.endingSoon", { days: plan.trialDaysLeft })}
                    >
                        <s-stack direction="inline" gap="base">
                            <s-link href="/app/plans">{t("trial.upgrade")}</s-link>
                            <s-link href="/app/plans">{t("trial.compare")}</s-link>
                        </s-stack>
                    </s-banner>
                </s-section>
            ) : null}

            {/* ② 降级说明卡：首次打开后台只提示一次，逐条说清代价 */}
            {plan.plan === "free" && winback.showSummary ? (
                <s-section>
                    <s-box padding="base" border="base" borderRadius="base">
                        <s-stack direction="block" gap="base">
                            <s-heading>{t("winback.summary")}</s-heading>
                            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                                <li>{t("winback.storefrontLive")}</li>
                                <li>
                                    {t("winback.readOnly", { n: winback.productsReadOnly })}
                                </li>
                                <li>
                                    {t("winback.discountsPaused", {
                                        n: winback.discountsPaused,
                                    })}
                                </li>
                                <li>{t("winback.dataKept")}</li>
                            </ul>
                            <s-stack direction="inline" gap="base">
                                <s-link href="/app/plans">{t("winback.restore")}</s-link>
                                <s-button
                                    variant="tertiary"
                                    disabled={fetcher.state !== "idle"}
                                    onClick={() =>
                                        fetcher.submit(
                                            { intent: "dismiss-winback" },
                                            { method: "post" },
                                        )
                                    }
                                >
                                    {t("winback.keepFree")}
                                </s-button>
                            </s-stack>
                        </s-stack>
                    </s-box>
                </s-section>
            ) : null}

            <s-section>
                <s-paragraph>{t("overview.placeholder")}</s-paragraph>
            </s-section>
        </s-page>
    );
}