import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureTablelySetup, getShopSettingsRow } from "../services/settings.server";
import { getWinbackSummary, markWinbackSeen, readPlanStatus } from "../services/billing.server";
import { countPendingApplications } from "../services/applications.server";
import {
    FREE_PRODUCT_LIMIT,
    countEnabledTables,
    maxTablesForPlan,
} from "../services/tables.server";
import { getPreviewUrl } from "../services/design.server";
import { getShopTimezone, loadAddToCartStats } from "../services/stats.server";
import { QUICK_ORDER_PATH } from "../proxy-paths";
import { getT, localeFromRequest, type Locale } from "../i18n";

/**
 * Overview（M14 / §六 / §6.1）
 *
 * 四块内容：
 *   ① 额度用量条 —— Free 显示「已用 X / 3」，超限如实显示 `X / 3（超出）`（§1.6）；
 *   ② 配置引导清单 —— `blockAdded → firstProductDone → storefrontVerified`，
 *      三步状态**直接由三个激活时间戳派生**（非 localStorage，重进后台不丢，§6.1）；
 *   ③ 统计卡（Pro）—— 今日 / 近 7 天 / 近 30 天加购行数·件数 / Top 变体 / 平均每单行数
 *      （按**店铺时区**日历日，§1.4 #26；不含转化率）；未激活前不显示统计卡；
 *      Free 显示升级引导；已激活但 30 天无数据 → 空态（不显示 0 值图表）；
 *   ④ 快捷入口 —— 打开补货页、待审批申请（有则显示）、升级 / 恢复 Pro。
 *
 * 另承接 M9 的两个应用内触点（§19.4，**非弹窗**）：试用将尽提示条 + 降级说明卡。
 *
 * M4 起这里额外承担**安装自愈兜底**：`afterAuth` 的播种若失败（或历史店铺缺配置），
 * 商家只要打开后台就会重跑同一套幂等流程。失败只记日志，不阻塞页面。
 */

/** 主题编辑器（Apps 区）—— 引导第 ① 步「把订购表加到主题」的落点 */
function themeEditorUrl(shop: string): string {
    const handle = shop.replace(/\.myshopify\.com$/, "");
    return `https://admin.shopify.com/store/${handle}/themes/current/editor?context=apps`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;
    try {
        await ensureTablelySetup({ admin, shop });
    } catch (error) {
        console.error("[tablely] Overview 安装自愈失败:", error);
    }

    const [plan, winback, pendingApplications, settings, enabledCount] = await Promise.all([
        readPlanStatus(shop),
        getWinbackSummary(shop),
        countPendingApplications(shop),
        getShopSettingsRow(shop),
        countEnabledTables(shop),
    ]);

    const isPro = plan.plan === "pro";
    // 引导三步状态 = 三个激活时间戳是否已写入（§6.1：状态存 shop 级配置，非 localStorage）
    const firstProductDone = Boolean(settings?.firstProductAt);

    // 引导第 ③ 步「到店面确认效果」需要一个真实商品页地址（仅在已配置时有意义）
    const previewUrl = firstProductDone
        ? await getPreviewUrl({ admin, shop }).catch(() => null)
        : null;

    // 统计为 Pro 能力，且未激活前不显示（§6.1）；时区只在真要出数时才查
    const stats =
        isPro && firstProductDone
            ? await loadAddToCartStats({
                shop,
                timezone: await getShopTimezone(admin),
                admin,
            })
            : null;

    return {
        locale: localeFromRequest(request),
        plan,
        winback,
        pendingApplications,
        isPro,
        quota: {
            used: enabledCount,
            limit: maxTablesForPlan(plan.plan),
            overLimit: !isPro && enabledCount > FREE_PRODUCT_LIMIT,
        },
        guide: {
            blockAdded: Boolean(settings?.blockAddedAt),
            firstProductDone,
            storefrontVerified: Boolean(settings?.firstAddToCart),
        },
        stats,
        previewUrl,
        themeEditorUrl: themeEditorUrl(shop),
        quickOrderUrl: `https://${shop}${QUICK_ORDER_PATH}`,
    };
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

type GuideStep = {
    key: "blockAdded" | "firstProductDone" | "storefrontVerified";
    title: string;
    body: string;
    cta: string;
    done: boolean;
};

export default function OverviewPage() {
    const {
        locale,
        plan,
        winback,
        pendingApplications,
        isPro,
        quota,
        guide,
        stats,
        previewUrl,
        themeEditorUrl: editorUrl,
        quickOrderUrl,
    } = useLoaderData<typeof loader>();
    const t = getT(locale as Locale);
    const fetcher = useFetcher<typeof action>();

    const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

    const steps: GuideStep[] = [
        {
            key: "blockAdded",
            title: t("overview.guideBlock"),
            body: t("overview.guideBlockBody"),
            cta: t("overview.guideBlockCta"),
            done: guide.blockAdded,
        },
        {
            key: "firstProductDone",
            title: t("overview.guideProduct"),
            body: t("overview.guideProductBody"),
            cta: t("overview.guideProductCta"),
            done: guide.firstProductDone,
        },
        {
            key: "storefrontVerified",
            title: t("overview.guideStorefront"),
            body: t("overview.guideStorefrontBody"),
            cta: t("overview.guideStorefrontCta"),
            done: guide.storefrontVerified,
        },
    ];

    const quotaText = quota.overLimit
        ? t("quota.overLimit", { used: quota.used, limit: quota.limit })
        : t("quota.products", {
            used: quota.used,
            limit: quota.limit === Number.POSITIVE_INFINITY ? "∞" : quota.limit,
        });

    return (
        <s-page heading={t("overview.title")}>
            {/* ① 试用将尽提示条：只在剩余 1–2 天出现，非弹窗（§19.4 触点①） */}
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

            {/* ② 待审批申请入口（§15.2：只做应用内通知，不发邮件） */}
            {pendingApplications > 0 ? (
                <s-section>
                    <s-banner tone="info">
                        <s-stack direction="inline" gap="base" alignItems="center">
                            <s-text>
                                {t("overview.pendingApplications", { n: pendingApplications })}
                            </s-text>
                            <s-link href="/app/wholesale">
                                {t("overview.reviewApplications")}
                            </s-link>
                        </s-stack>
                    </s-banner>
                </s-section>
            ) : null}

            {/* ③ 降级说明卡：首次打开后台只提示一次，逐条说清代价（§19.4 触点②） */}
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

            {/* ④ 额度用量条（Free）；Pro 显示无上限 */}
            <s-section>
                <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                >
                    <s-text color="subdued">{quotaText}</s-text>
                    <s-stack direction="inline" gap="base">
                        <s-button onClick={() => openExternal(quickOrderUrl)}>
                            {t("overview.openQuickOrder")}
                        </s-button>
                        <s-link href="/app/tables">{t("nav.tables")}</s-link>
                    </s-stack>
                </s-stack>
            </s-section>

            {/* ⑤ 配置引导清单（可勾选、可续上；状态来自 shop 级时间戳） */}
            <s-section>
                <s-stack direction="block" gap="base">
                    <s-heading>{t("overview.guideTitle")}</s-heading>
                    {steps.map((step) => (
                        <s-box
                            key={step.key}
                            padding="base"
                            border="base"
                            borderRadius="base"
                        >
                            <s-stack
                                direction="inline"
                                gap="base"
                                alignItems="center"
                                justifyContent="space-between"
                            >
                                <s-stack direction="block" gap="small">
                                    <s-text>{step.title}</s-text>
                                    <s-text color="subdued">{step.body}</s-text>
                                </s-stack>
                                {step.done ? (
                                    <s-badge tone="success">
                                        {t("overview.guideDone")}
                                    </s-badge>
                                ) : step.key === "firstProductDone" ? (
                                    <s-link href="/app/tables">{step.cta}</s-link>
                                ) : step.key === "storefrontVerified" ? (
                                    <s-button
                                        disabled={!previewUrl}
                                        onClick={() =>
                                            previewUrl ? openExternal(previewUrl) : undefined
                                        }
                                    >
                                        {step.cta}
                                    </s-button>
                                ) : (
                                    <s-button onClick={() => openExternal(editorUrl)}>
                                        {step.cta}
                                    </s-button>
                                )}
                            </s-stack>
                        </s-box>
                    ))}
                </s-stack>
            </s-section>

            {/* ⑥ 统计卡（Pro）/ Free 升级引导；未激活前不显示（§6.1） */}
            {!isPro ? (
                <s-section>
                    <s-banner tone="info" heading={t("stats.proTitle")}>
                        <s-stack direction="block" gap="base">
                            <s-text>{t("stats.proBody")}</s-text>
                            <s-link href="/app/plans">{t("stats.upgrade")}</s-link>
                        </s-stack>
                    </s-banner>
                </s-section>
            ) : guide.firstProductDone && stats ? (
                stats.totals["30d"].rows === 0 ? (
                    <s-section>
                        <s-empty-state heading={t("empty.stats.title")}>
                            <s-text slot="subheading">{t("empty.stats.body")}</s-text>
                            <s-button
                                slot="secondary-actions"
                                onClick={() => openExternal(editorUrl)}
                            >
                                {t("empty.stats.cta")}
                            </s-button>
                        </s-empty-state>
                    </s-section>
                ) : (
                    <s-section>
                        <s-stack direction="block" gap="base">
                            <s-heading>{t("stats.title")}</s-heading>
                            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                                {(
                                    [
                                        ["today", t("stats.today")],
                                        ["7d", t("stats.last7Days")],
                                        ["30d", t("stats.last30Days")],
                                    ] as const
                                ).map(([key, label]) => (
                                    <s-box
                                        key={key}
                                        padding="base"
                                        border="base"
                                        borderRadius="base"
                                    >
                                        <s-stack direction="block" gap="small">
                                            <s-text color="subdued">{label}</s-text>
                                            <s-text>
                                                {t("stats.addToCartRows")}:{" "}
                                                {stats.totals[key].rows}
                                            </s-text>
                                            <s-text>
                                                {t("stats.addToCartUnits")}:{" "}
                                                {stats.totals[key].units}
                                            </s-text>
                                            <s-text>
                                                {t("stats.avgRowsPerOrder")}:{" "}
                                                {stats.totals[key].avgRowsPerOrder}
                                            </s-text>
                                        </s-stack>
                                    </s-box>
                                ))}
                            </s-grid>

                            {stats.topVariants.length > 0 ? (
                                <s-stack direction="block" gap="small">
                                    <s-text>{t("stats.topVariants")}</s-text>
                                    {stats.topVariants.map((item) => (
                                        <s-text key={item.variantId} color="subdued">
                                            {item.label ?? `#${item.variantId}`} — {item.units}
                                        </s-text>
                                    ))}
                                </s-stack>
                            ) : null}
                        </s-stack>
                    </s-section>
                )
            ) : null}

            {/* ⑦ 评论飞轮（不诱导）：仅在已激活店铺显示一条中性提示（§23.3） */}
            {guide.storefrontVerified ? (
                <s-section>
                    <s-text color="subdued">{t("review.prompt")}</s-text>
                </s-section>
            ) : null}
        </s-page>
    );
}
