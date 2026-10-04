import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { hasFeature } from "../plan";
import {
    DESIGN_CHOICES,
    NATIVE_SELECTOR_CANDIDATES,
    RADIUS_MAX,
    RADIUS_MIN,
} from "../design-choices";
import {
    getDesignSettings,
    getPreviewUrl,
    isTablelyError,
    saveDesignSettings,
} from "../services/design.server";
import { resolvePlan } from "../services/tables.server";

/**
 * Design（M8）—— 外观 / 行为 / 高级
 *
 * 三段配置全部落在 Shop 级 `ShopSettings` 一行，保存后立即重建并下发
 * `tablely.settings` metafield（`saveDesignSettings`）→ 店面 Liquid 下次渲染即生效，
 * 满足 M8「样式即时生效」（无需重新部署、无需改主题）。
 *
 * 高级段是 **B1 隐藏主题自带加购区**：默认关闭，选择器可配置（内置候选 + 自由输入），
 * 安全兜底由店面侧结构性保证（`table-style.liquid` 只在表格确实渲染时才输出，
 * 见 §2.8 约束 6 / §十二 验收 14）。这里只负责「配得清楚、存得安全」。
 *
 * Pro 门控（M9 付费墙，§19.3）：
 *   · 外观 4 字段（品牌色 / 圆角 / 密度 / 字体，#27）属 Pro；
 *   · 缺货策略（#13）属 Pro；
 *   · 含税显示（#14）/ 反馈样式（#7）/ 隐藏加购区（#32）属 Free，保持可用。
 *   Free 下 Pro 字段**禁用编辑**并显示 Pro 徽章 + 升级链接；后端 `saveDesignSettings`
 *   对 Pro 值变化同样拒写（双保险），此处捕获 `isTablelyError` 回显 `error.proRequired`。
 */

type DesignActionData =
    | { ok: true }
    | { ok: false; errorKey: string; field?: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const locale = localeFromRequest(request);

    const [settings, plan] = await Promise.all([
        getDesignSettings(session.shop),
        resolvePlan(session.shop),
    ]);

    // 预览链接失败不应影响整页（无已启用商品 → null，按钮禁用）
    let previewUrl: string | null = null;
    try {
        previewUrl = await getPreviewUrl({ admin, shop: session.shop });
    } catch (error) {
        console.error("[tablely] design preview url failed:", error);
    }

    return { locale, settings, previewUrl, plan };
};

export const action = async ({
    request,
}: ActionFunctionArgs): Promise<DesignActionData> => {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();

    try {
        await saveDesignSettings({
            admin,
            shop: session.shop,
            values: {
                brandColor: String(formData.get("brandColor") ?? ""),
                radius: String(formData.get("radius") ?? ""),
                density: String(formData.get("density") ?? ""),
                font: String(formData.get("font") ?? ""),
                taxDisplay: String(formData.get("taxDisplay") ?? ""),
                outOfStock: String(formData.get("outOfStock") ?? ""),
                feedbackStyle: String(formData.get("feedbackStyle") ?? ""),
                hideNative: formData.get("hideNative") === "on",
                nativeSelector: String(formData.get("nativeSelector") ?? ""),
            },
        });
        return { ok: true };
    } catch (error) {
        // Pro 门控拒写：回显 `error.proRequired`（Free 改动 Pro 值）
        if (isTablelyError(error)) {
            return { ok: false, errorKey: error.key, field: error.field ?? undefined };
        }
        console.error("[tablely] design action failed:", error);
        // 写 metafield 失败必须显式报错，不允许静默成功（§六 共用交互）
        return { ok: false, errorKey: "error.metafieldFailed" };
    }
};

const valueOf = (event: Event): string =>
    String((event.currentTarget as unknown as { value?: string } | null)?.value ?? "");
const checkedOf = (event: Event): boolean =>
    Boolean((event.currentTarget as unknown as { checked?: boolean } | null)?.checked);

const CUSTOM_PRESET = "__custom__";

/** Free 下显示的「Pro 功能」提示：徽章 + 升级链接（§19.3） */
function ProHint({ label, upgrade }: { label: string; upgrade: string }) {
    return (
        <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">{label}</s-badge>
            <s-link href="/app/plans">{upgrade}</s-link>
        </s-stack>
    );
}

export default function DesignPage() {
    const { locale, settings, previewUrl, plan } = useLoaderData<typeof loader>();
    const t = getT(locale);
    const shopify = useAppBridge();
    const fetcher = useFetcher<typeof action>();

    const canCustomStyle = hasFeature(plan, "custom_style");
    const canOutOfStock = hasFeature(plan, "out_of_stock");

    const [brandColor, setBrandColor] = useState(settings.style.brandColor ?? "");
    const [radius, setRadius] = useState(
        settings.style.radius === null ? "" : String(settings.style.radius),
    );
    const [density, setDensity] = useState<string>(settings.style.density);
    const [font, setFont] = useState<string>(settings.style.font);
    const [taxDisplay, setTaxDisplay] = useState<string>(settings.taxDisplay);
    const [outOfStock, setOutOfStock] = useState<string>(settings.outOfStock);
    const [feedbackStyle, setFeedbackStyle] = useState<string>(settings.feedbackStyle);
    const [hideNative, setHideNative] = useState(settings.hideNative);
    const [selector, setSelector] = useState(settings.nativeSelector);

    const saved = fetcher.data?.ok === true;
    const failed = fetcher.data?.ok === false ? fetcher.data : null;

    useEffect(() => {
        if (saved) shopify.toast.show(t("toast.saved"));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetcher.data]);

    const save = () => {
        fetcher.submit(
            {
                brandColor,
                radius,
                density,
                font,
                taxDisplay,
                outOfStock,
                feedbackStyle,
                hideNative: hideNative ? "on" : "off",
                nativeSelector: selector,
            },
            { method: "post" },
        );
    };

    const presetValue = (NATIVE_SELECTOR_CANDIDATES as readonly string[]).includes(selector)
        ? selector
        : CUSTOM_PRESET;

    return (
        <s-page heading={t("design.title")}>
            {failed ? (
                <s-banner tone="critical">{t(failed.errorKey)}</s-banner>
            ) : null}

            <s-section heading={t("design.appearance")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("design.appearanceHint")}</s-text>
                    {!canCustomStyle ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    <s-color-field
                        label={t("design.brandColor")}
                        details={t("design.brandColorHint")}
                        value={brandColor}
                        disabled={!canCustomStyle}
                        onChange={(event) => setBrandColor(valueOf(event))}
                    />

                    <s-number-field
                        label={t("design.radius")}
                        details={t("design.radiusHint")}
                        value={radius}
                        min={RADIUS_MIN}
                        max={RADIUS_MAX}
                        step={1}
                        disabled={!canCustomStyle}
                        onChange={(event) => setRadius(valueOf(event))}
                    />

                    <s-select
                        label={t("design.density")}
                        value={density}
                        disabled={!canCustomStyle}
                        onChange={(event) => setDensity(valueOf(event))}
                    >
                        {DESIGN_CHOICES.densities.map((option) => (
                            <s-option key={option} value={option}>
                                {t(`design.density.${option}`)}
                            </s-option>
                        ))}
                    </s-select>
                    <s-text color="subdued">{t("design.densityHint")}</s-text>

                    <s-select
                        label={t("design.font")}
                        value={font}
                        disabled={!canCustomStyle}
                        onChange={(event) => setFont(valueOf(event))}
                    >
                        {DESIGN_CHOICES.fonts.map((option) => (
                            <s-option key={option} value={option}>
                                {t(`design.font.${option}`)}
                            </s-option>
                        ))}
                    </s-select>
                    <s-text color="subdued">{t("design.fontHint")}</s-text>
                </s-stack>
            </s-section>

            <s-section heading={t("design.behavior")}>
                <s-stack direction="block" gap="base">
                    <s-select
                        label={t("design.taxDisplay")}
                        value={taxDisplay}
                        onChange={(event) => setTaxDisplay(valueOf(event))}
                    >
                        {DESIGN_CHOICES.taxDisplays.map((option) => (
                            <s-option key={option} value={option}>
                                {t(`design.taxDisplay.${option}`)}
                            </s-option>
                        ))}
                    </s-select>
                    <s-text color="subdued">{t("design.taxDisplayHint")}</s-text>

                    <s-select
                        label={t("design.outOfStock")}
                        value={outOfStock}
                        disabled={!canOutOfStock}
                        onChange={(event) => setOutOfStock(valueOf(event))}
                    >
                        {DESIGN_CHOICES.outOfStockModes.map((option) => (
                            <s-option key={option} value={option}>
                                {t(`design.outOfStock.${option}`)}
                            </s-option>
                        ))}
                    </s-select>
                    <s-text color="subdued">{t("design.outOfStockHint")}</s-text>
                    {!canOutOfStock ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    <s-select
                        label={t("design.feedbackStyle")}
                        value={feedbackStyle}
                        onChange={(event) => setFeedbackStyle(valueOf(event))}
                    >
                        {DESIGN_CHOICES.feedbackStyles.map((option) => (
                            <s-option key={option} value={option}>
                                {t(`design.feedbackStyle.${option}`)}
                            </s-option>
                        ))}
                    </s-select>
                    <s-text color="subdued">{t("design.feedbackStyleHint")}</s-text>
                </s-stack>
            </s-section>

            <s-section heading={t("design.advanced")}>
                <s-stack direction="block" gap="base">
                    <s-switch
                        label={t("design.hideNative")}
                        checked={hideNative}
                        onChange={(event) => setHideNative(checkedOf(event))}
                    />
                    <s-text color="subdued">{t("design.hideNativeHint")}</s-text>

                    {hideNative ? (
                        <s-stack direction="block" gap="base">
                            <s-select
                                label={t("design.selectorPreset")}
                                value={presetValue}
                                onChange={(event) => {
                                    const next = valueOf(event);
                                    if (next !== CUSTOM_PRESET) setSelector(next);
                                }}
                            >
                                {NATIVE_SELECTOR_CANDIDATES.map((candidate) => (
                                    <s-option key={candidate} value={candidate}>
                                        {candidate}
                                    </s-option>
                                ))}
                                <s-option value={CUSTOM_PRESET}>
                                    {t("design.selectorPreset.custom")}
                                </s-option>
                            </s-select>

                            <s-text-field
                                label={t("design.selector")}
                                details={t("design.selectorHint")}
                                value={selector}
                                onChange={(event) => setSelector(valueOf(event))}
                            />

                            <s-stack direction="inline" gap="base" alignItems="center">
                                <s-button
                                    disabled={!previewUrl}
                                    onClick={() => {
                                        if (previewUrl) {
                                            window.open(previewUrl, "_blank", "noopener");
                                        }
                                    }}
                                >
                                    {t("design.previewImpact")}
                                </s-button>
                                {!previewUrl ? (
                                    <s-text color="subdued">
                                        {t("design.previewDisabled")}
                                    </s-text>
                                ) : null}
                            </s-stack>
                        </s-stack>
                    ) : null}

                    <s-text color="subdued">
                        <s-link href="/app/help">{t("design.advancedHelp")}</s-link>
                    </s-text>
                </s-stack>
            </s-section>

            <s-section>
                <s-stack direction="inline" gap="base">
                    <s-button
                        variant="primary"
                        disabled={fetcher.state !== "idle"}
                        onClick={save}
                    >
                        {t("design.save")}
                    </s-button>
                </s-stack>
            </s-section>
        </s-page>
    );
}
