import { useEffect, useRef } from "react";
import type {
    ActionFunctionArgs,
    HeadersFunction,
    LoaderFunctionArgs,
} from "react-router";
import {
    useFetcher,
    useLoaderData,
    useNavigate,
    useSearchParams,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { PLAN_OPTIONS, TRIAL_DAYS, isPlanKey, type BillingInterval, type PlanKey } from "../plan";
import {
    billingTestMode,
    cancelSubscription,
    changePlan,
    createSubscription,
    getActiveSubscription,
    getWinbackSummary,
    readPlanStatus,
    syncPlanFromShopify,
    syncSubscriptionState,
} from "../services/billing.server";

type LoaderSubscription = {
    status: string;
    interval: BillingInterval | null;
    currentPeriodEnd: string | null;
};

/**
 * Plans —— Free / Pro 对照 + 订阅 / 切周期 / 应用内降级（App Store 审核 1.2.3）
 *
 * loader：向 Shopify **兜底查一次**订阅状态——创建订阅后 Shopify 会带 `?shop=`
 * 回跳本页，此时必须主动向 Shopify 确认而不是信本地快照（沿用 Linkly 已验证做法）。
 *
 * action：
 *   - subscribe/switch：appSubscriptionCreate（switch 先 prorate=true 取消旧单），
 *     再以 `401 + X-Shopify-API-Request-Failure-Reauthorize-Url` 跳出 iframe；
 *   - cancel：appSubscriptionCancel(prorate=false)，权益保留到当前周期末（降级宽限）。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const locale = localeFromRequest(request);

    let plan = await readPlanStatus(session.shop);
    let subscription: LoaderSubscription | null = null;
    // CANCELLED 但权益保留到期末（prorate=false 降级宽限期）
    let graceUntil: string | null = null;

    try {
        const synced = await syncPlanFromShopify(admin, session.shop);
        plan = await readPlanStatus(session.shop);
        if (synced.active) {
            subscription = {
                status: synced.active.status,
                interval: synced.active.interval,
                currentPeriodEnd: synced.active.currentPeriodEnd,
            };
        } else if (synced.plan === "pro") {
            graceUntil = plan.periodEndsAt;
        }
    } catch (error) {
        console.error("[tablely] plans 订阅状态同步失败:", error);
    }

    const winback = await getWinbackSummary(session.shop);

    return {
        locale,
        plan,
        winback,
        subscription,
        graceUntil,
        trialDays: TRIAL_DAYS,
        priceMonthly: PLAN_OPTIONS.pro_monthly.amount,
        priceAnnual: PLAN_OPTIONS.pro_annual.amount,
    };
};

export const action = async ({ request }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "subscribe");
    const shop = session.shop;

    // 应用内降级：取消订阅（prorate=false，权益保留到当前周期末）
    if (intent === "cancel") {
        try {
            const active = await getActiveSubscription(admin);
            if (!active) {
                return { ok: false as const, errorKey: "plans.error" };
            }
            const cancelled = await cancelSubscription(admin, {
                id: active.id,
                prorate: false,
            });
            await syncSubscriptionState(admin, shop, cancelled);
            return { ok: true as const, cancelled: true as const };
        } catch (error) {
            console.error("[tablely] cancelSubscription failed:", error);
            return { ok: false as const, errorKey: "plans.error" };
        }
    }

    const raw = String(formData.get("planKey") ?? "");
    if (!isPlanKey(raw)) {
        return { ok: false as const, errorKey: "error.saveFailed" };
    }
    const planKey: PlanKey = raw;

    // 批准后回跳地址必须落在 Admin 内嵌地址（§七）：回 https://<appUrl>/app/plans
    // 是非嵌入顶层导航且不带 host 参数，authenticate.admin 会抛错 → 白屏。
    const handle = shop.replace(".myshopify.com", "");
    const returnUrl = `https://admin.shopify.com/store/${handle}/apps/${process.env.SHOPIFY_API_KEY}/app/plans`;

    try {
        // switch：旧订阅 prorate=true 立即按比例取消，再开新订阅（月⇄年互切）
        const confirmationUrl =
            intent === "switch"
                ? await changePlan(admin, {
                      planKey,
                      returnUrl,
                      test: billingTestMode(),
                  })
                : await createSubscription(admin, {
                      planKey,
                      returnUrl,
                      test: billingTestMode(),
                  });

        // 必须跳出 App Bridge 的 iframe 才能打开 Shopify 托管确认页。
        throw new Response(null, {
            status: 401,
            statusText: "Unauthorized",
            headers: {
                "X-Shopify-API-Request-Failure-Reauthorize-Url": confirmationUrl,
            },
        });
    } catch (error) {
        if (error instanceof Response) throw error;
        console.error(`[tablely] ${intent} failed:`, error);
        return { ok: false as const, errorKey: "plans.error" };
    }
};

// s-modal 的实例类型（含 showOverlay/hideOverlay）由 @shopify/polaris-types
// 注入到 JSX IntrinsicElements，这里反推出来用于 ref
type SModalElement = NonNullable<
    Extract<
        NonNullable<React.JSX.IntrinsicElements["s-modal"]["ref"]>,
        { current: unknown }
    >["current"]
>;

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
        subscription,
        graceUntil,
        trialDays,
        priceMonthly,
        priceAnnual,
    } = useLoaderData<typeof loader>();
    const t = getT(locale);
    const fetcher = useFetcher<typeof action>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const cancelModalRef = useRef<SModalElement>(null);

    const isPro = plan.plan === "pro";
    const busy = ["loading", "submitting"].includes(fetcher.state);
    const failed = fetcher.data?.ok === false ? fetcher.data.errorKey : null;
    const justCancelled = searchParams.get("cancelled") === "1";
    const inGrace = isPro && Boolean(graceUntil) && !subscription;

    useEffect(() => {
        const data = fetcher.data;
        if (data && data.ok && "cancelled" in data && data.cancelled) {
            cancelModalRef.current?.hideOverlay();
            navigate("/app/plans?cancelled=1");
        }
    }, [fetcher.data, navigate]);

    const subscribe = (planKey: PlanKey, intent: "subscribe" | "switch") =>
        fetcher.submit({ intent, planKey }, { method: "post" });
    const confirmCancel = () =>
        fetcher.submit({ intent: "cancel" }, { method: "post" });

    const formatDate = (iso: string) =>
        new Intl.DateTimeFormat(locale, {
            year: "numeric",
            month: "long",
            day: "numeric",
        }).format(new Date(iso));

    // 年付订户切月付，其它（月付/试用）切年付
    const isAnnual = subscription?.interval === "ANNUAL";
    const switchTarget: PlanKey = isAnnual ? "pro_monthly" : "pro_annual";
    const activeUntil = subscription?.currentPeriodEnd
        ? formatDate(subscription.currentPeriodEnd)
        : null;
    const graceDate = graceUntil ? formatDate(graceUntil) : null;
    const showTrial =
        isPro &&
        !inGrace &&
        !justCancelled &&
        plan.billingStatus !== "CANCELLED" &&
        plan.trialDaysLeft !== null;

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
            {/* ③ 常驻挽回条：只用 DB 实时数字（§19.4），不写死；宽限期仍算 Pro 不显示 */}
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
                                loading={busy}
                                onClick={() => subscribe("pro_monthly", "subscribe")}
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

            {justCancelled && graceDate ? (
                <s-section>
                    <s-banner tone="success">
                        {t("plans.cancelSuccess", { date: graceDate })}
                    </s-banner>
                </s-section>
            ) : null}

            {!justCancelled && inGrace && graceDate ? (
                <s-section>
                    <s-banner tone="warning">
                        {t("plans.graceBanner", { date: graceDate })}
                    </s-banner>
                </s-section>
            ) : null}

            {isPro && !inGrace && !justCancelled ? (
                <s-section>
                    <s-banner tone="success">
                        {showTrial
                            ? t("plans.pro.trial", { days: plan.trialDaysLeft ?? 0 })
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

                        {isPro && subscription ? (
                            <>
                                {activeUntil ? (
                                    <s-text color="subdued">
                                        {t("plans.renewsOn", { date: activeUntil })}
                                    </s-text>
                                ) : null}
                                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                    <s-button
                                        variant="secondary"
                                        loading={busy}
                                        onClick={() => subscribe(switchTarget, "switch")}
                                    >
                                        {isAnnual
                                            ? t("plans.switchMonthly")
                                            : t("plans.switchAnnual")}
                                    </s-button>
                                    <s-button
                                        variant="tertiary"
                                        tone="critical"
                                        command="--show"
                                        commandFor="cancel-plan-modal"
                                    >
                                        {t("plans.cancel")}
                                    </s-button>
                                </div>
                            </>
                        ) : (
                            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                                <s-button
                                    variant="primary"
                                    loading={busy}
                                    onClick={() => subscribe("pro_monthly", "subscribe")}
                                >
                                    {t("plans.subscribe.monthly", { days: trialDays })}
                                </s-button>
                                <s-button
                                    loading={busy}
                                    onClick={() => subscribe("pro_annual", "subscribe")}
                                >
                                    {t("plans.subscribe.annual")}
                                </s-button>
                            </div>
                        )}

                        {inGrace && graceDate ? (
                            <s-text color="subdued">
                                {t("plans.proUntil", { date: graceDate })}
                            </s-text>
                        ) : null}
                    </div>
                </div>
            </s-section>

            <s-section>
                <s-text color="subdued">{t("plans.billingNote")}</s-text>
            </s-section>

            <s-modal
                id="cancel-plan-modal"
                heading={t("plans.cancelTitle")}
                size="small"
                ref={cancelModalRef}
            >
                {failed ? (
                    <s-banner tone="critical">{t(failed)}</s-banner>
                ) : null}
                <s-paragraph>
                    {activeUntil
                        ? t("plans.cancelBody", { date: activeUntil })
                        : t("plans.cancelBodyNoDate")}
                </s-paragraph>
                <s-button
                    slot="secondary-actions"
                    variant="secondary"
                    command="--hide"
                    commandFor="cancel-plan-modal"
                >
                    {t("plans.cancelKeep")}
                </s-button>
                <s-button
                    slot="primary-action"
                    variant="primary"
                    tone="critical"
                    loading={busy}
                    onClick={confirmCancel}
                >
                    {t("plans.cancelConfirm")}
                </s-button>
            </s-modal>
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
