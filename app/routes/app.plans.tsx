import type {
    ActionFunctionArgs,
    HeadersFunction,
    LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { PLAN_OPTIONS, TRIAL_DAYS, isPlanKey, type PlanKey } from "../plan";
import {
    billingTestMode,
    createSubscription,
    getWinbackSummary,
    readPlanStatus,
    syncPlanFromShopify,
} from "../services/billing.server";

/**
 * Plans —— Free / Pro 对照 + 订阅（M9，方案 §19.1 / §19.2）
 *
 * loader：向 Shopify **兜底查一次**订阅状态——创建订阅后 Shopify 会带 `?shop=`
 * 回跳本页，此时必须主动向 Shopify 确认而不是信本地快照（沿用 Linkly 已验证做法）。
 * 同时算出「常驻挽回条」（§19.4 触点③）所需的真实数字。
 *
 * action：调 `appSubscriptionCreate` 拿托管确认页 URL，然后
 * `401 + X-Shopify-API-Request-Failure-Reauthorize-Url` 跳出 App Bridge 的 iframe
 *（官方 redirectOutOfApp 手法）。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const locale = localeFromRequest(request);

    let plan = await readPlanStatus(session.shop);
    try {
        await syncPlanFromShopify(admin, session.shop);
        plan = await readPlanStatus(session.shop);
    } catch (error) {
        console.error("[tablely] plans 订阅状态同步失败:", error);
    }

    const winback = await getWinbackSummary(session.shop);
    const currency = PLAN_OPTIONS.pro_monthly.amount; // 仅用于文案占位（USD 固定）

    return {
        locale,
        plan,
        winback,
        trialDays: TRIAL_DAYS,
        priceMonthly: PLAN_OPTIONS.pro_monthly.amount,
        priceAnnual: PLAN_OPTIONS.pro_annual.amount,
        currency,
    };
};

export const action = async ({ request }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const raw = String(formData.get("planKey") ?? "");
    if (!isPlanKey(raw)) {
        return { ok: false as const, errorKey: "error.saveFailed" };
    }
    const planKey: PlanKey = raw;

    // 批准后回跳地址必须落在 Admin 内嵌地址（§七）：回 https://<appUrl>/app/plans
    // 是非嵌入顶层导航且不带 host 参数，authenticate.admin 会抛错 → 白屏。
    const handle = session.shop.replace(".myshopify.com", "");
    const returnUrl = `https://admin.shopify.com/store/${handle}/apps/${process.env.SHOPIFY_API_KEY}/app/plans`;

    let confirmationUrl: string;
    try {
        confirmationUrl = await createSubscription(admin, {
            planKey,
            returnUrl,
            test: billingTestMode(),
        });
    } catch (error) {
        console.error("[tablely] createSubscription failed:", error);
        return { ok: false as const, errorKey: "plans.error" };
    }

    // 必须跳出 App Bridge 的 iframe 才能打开 Shopify 托管确认页。
    throw new Response(null, {
        status: 401,
        statusText: "Unauthorized",
        headers: { "X-Shopify-API-Request-Failure-Reauthorize-Url": confirmationUrl },
    });
};

const FREE_FEATURES = ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"] as const;
const PRO_FEATURES = [
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
    "f13",
    "f14",
    "f15",
    "f16",
    "f17",
] as const;

export default function PlansPage() {
    const {
        locale,
        plan,
        winback,
        trialDays,
        priceMonthly,
        priceAnnual,
    } = useLoaderData<typeof loader>();
    const t = getT(locale);
    const fetcher = useFetcher<typeof action>();

    const isPro = plan.plan === "pro";
    const failed = fetcher.data?.ok === false ? fetcher.data.errorKey : null;
    const subscribe = (planKey: PlanKey) =>
        fetcher.submit({ planKey }, { method: "post" });

    const cardStyle: React.CSSProperties = {
        display: "grid",
        gap: 10,
        alignContent: "start",
        padding: 16,
        border: "1px solid #e1e3e5",
        borderRadius: 12,
        background: "#ffffff",
        minWidth: 260,
    };
    const listStyle: React.CSSProperties = {
        margin: 0,
        paddingLeft: 18,
        fontSize: 13,
        lineHeight: 1.9,
        color: "#202223",
    };

    return (
        <s-page heading={t("plans.title")}>
            {/* ③ 常驻挽回条：只用 DB 实时数字（§19.4），不写死 */}
            {!isPro && (winback.discountsPaused > 0 || winback.productsReadOnly > 0 || winback.featuresLocked > 0) ? (
                <s-section>
                    <s-banner tone="warning" heading={t("winback.summary")}>
                        <s-stack direction="block" gap="base">
                            <s-paragraph>
                                {t("plans.winback", {
                                    discounts: winback.discountsPaused,
                                    products: winback.productsReadOnly,
                                    features: winback.featuresLocked,
                                })}
                            </s-paragraph>
                            <s-button
                                variant="primary"
                                onClick={() => subscribe("pro_monthly")}
                                {...(["loading", "submitting"].includes(fetcher.state)
                                    ? { loading: true }
                                    : {})}
                            >
                                {t("plans.restore")}
                            </s-button>
                        </s-stack>
                    </s-banner>
                </s-section>
            ) : null}

            <s-section>
                <s-text color="subdued">{t("plans.subtitle")}</s-text>
            </s-section>

            {isPro ? (
                <s-section>
                    <s-banner tone="success">
                        {plan.trialDaysLeft !== null
                            ? t("plans.pro.trial", { days: plan.trialDaysLeft })
                            : t("plans.active")}
                    </s-banner>
                </s-section>
            ) : null}

            {failed ? (
                <s-section>
                    <s-banner tone="critical">{t(failed)}</s-banner>
                </s-section>
            ) : null}

            <s-section>
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                        gap: 16,
                    }}
                >
                    <div style={cardStyle}>
                        <s-text type="strong">{t("plans.free.name")}</s-text>
                        <span style={{ fontSize: 26, fontWeight: 650 }}>
                            {t("plans.free.price")}
                        </span>
                        <ul style={listStyle}>
                            {FREE_FEATURES.map((key) => (
                                <li key={key}>{t(`plans.free.${key}`)}</li>
                            ))}
                        </ul>
                        {!isPro ? (
                            <s-text color="subdued">{t("plans.free.current")}</s-text>
                        ) : null}
                    </div>

                    <div style={{ ...cardStyle, borderColor: "#303030", borderWidth: 2 }}>
                        <s-stack direction="inline" gap="small" alignItems="center">
                            <s-text type="strong">{t("plans.pro.name")}</s-text>
                            <s-badge tone="info">{t("pro.badge")}</s-badge>
                        </s-stack>
                        <span style={{ fontSize: 26, fontWeight: 650 }}>
                            {t("plans.pro.monthly", { price: priceMonthly })}
                        </span>
                        <s-text color="subdued">
                            {t("plans.pro.annual", { price: priceAnnual })}
                        </s-text>
                        <ul style={listStyle}>
                            {PRO_FEATURES.map((key) => (
                                <li key={key}>{t(`plans.pro.${key}`)}</li>
                            ))}
                        </ul>
                        <s-text color="subdued">
                            {t("plans.pro.trialHint", { days: trialDays })}
                        </s-text>

                        {isPro ? (
                            <s-text color="subdued">{t("plans.cancelHint")}</s-text>
                        ) : (
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                <s-button
                                    variant="primary"
                                    onClick={() => subscribe("pro_monthly")}
                                    {...(["loading", "submitting"].includes(fetcher.state)
                                        ? { loading: true }
                                        : {})}
                                >
                                    {t("plans.subscribe.monthly", { days: trialDays })}
                                </s-button>
                                <s-button
                                    onClick={() => subscribe("pro_annual")}
                                    {...(["loading", "submitting"].includes(fetcher.state)
                                        ? { loading: true }
                                        : {})}
                                >
                                    {t("plans.subscribe.annual")}
                                </s-button>
                            </div>
                        )}
                    </div>
                </div>
            </s-section>
        </s-page>
    );
}

/**
 * action 抛出的 401（带 X-Shopify-API-Request-Failure-Reauthorize-Url）要靠这一层
 * 把响应头透出去，App Bridge 才能接管顶层跳转到 Shopify 托管确认页。
 */
export const headers: HeadersFunction = (headersArgs) => {
    return boundary.headers(headersArgs);
};