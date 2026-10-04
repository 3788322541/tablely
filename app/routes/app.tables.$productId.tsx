import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { hasFeature, isProLayout } from "../plan";
import { MAX_TABLE_ROWS } from "../perf-limits";
import {
    getProductTable,
    getProductRefsByIds,
    getShopCurrency,
    getShopOrderMinAmount,
    isProductReadOnly,
    isTablelyError,
    listProductVariants,
    resolvePlan,
    saveProductTable,
    deleteProductTable,
} from "../services/tables.server";
import { saveTemplateFromProduct } from "../services/templates.server";

/**
 * 单商品订购表编辑器（M3）—— 右侧 Drawer
 *
 * 交互形态沿用 Linkly 已验证的做法：**固定定位的自定义 overlay + `role="dialog"` 右侧面板**，
 * 不用 `s-modal`（`s-modal` 只能命令式 `showOverlay()`，在嵌套路由下不如 overlay 稳）。
 * 打开 / 关闭由父路由的 `?edit=<productId>` 决定，本路由是 `app.tables.tsx` 的子路由。
 *
 * Pro 门控（M9 付费墙，§19.3）：
 *   · 非 table 布局（#3）与整单起订金额（#36）属 Pro → Free 下对应控件禁用并显示 Pro 徽章；
 *   · 另存为模板（#28）属 Pro → Free 下按钮禁用；
 *   · 降级后**超限商品只读**（§1.6）：整表控件锁定，仅允许「关闭启用」以释放额度。
 *   后端 `saveProductTable` 同样拒写（双保险）。
 *
 * ⚠️ 不能 import `.server` 模块到组件里（`.server` 在客户端会被替换成空模块），
 * 所以 GID → 数字 id 这类渲染期要用的纯函数在本文件内保留一份等价实现。
 */

/** `gid://shopify/ProductVariant/123` → `123`；非 GID 时原样返回 */
function numericId(gid: string): string {
    const match = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/.exec(gid.trim());
    return match ? match[1] : gid.trim();
}

const valueOf = (event: Event): string =>
    String((event.currentTarget as unknown as { value?: string } | null)?.value ?? "");
const checkedOf = (event: Event): boolean =>
    Boolean((event.currentTarget as unknown as { checked?: boolean } | null)?.checked);

/** 布局可选项（渲染实现属 M4/M6；M3 只负责把选择存下来） */
const LAYOUTS = ["table", "grid", "list", "matrix"] as const;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const locale = localeFromRequest(request);
    const productId = decodeURIComponent(params.productId ?? "");

    const isValidGid = productId.startsWith("gid://");
    const [product, table, variants, currency, shopOrderMinAmount, plan] = await Promise.all([
        isValidGid
            ? getProductRefsByIds(admin, [productId]).then((rows) => rows[0] ?? null)
            : Promise.resolve(null),
        isValidGid ? getProductTable(session.shop, productId) : Promise.resolve(null),
        isValidGid
            ? listProductVariants(admin, productId)
            : Promise.resolve([] as { id: string; title: string; sku: string | null }[]),
        getShopCurrency(admin),
        getShopOrderMinAmount(session.shop),
        resolvePlan(session.shop),
    ]);

    // 降级后超限只读（§1.6）：仅当该商品**已启用且超出 Free 额度**时锁定整表
    const readOnly =
        isValidGid && table?.enabled
            ? await isProductReadOnly(session.shop, productId)
            : false;

    return {
        locale,
        productId,
        currency,
        shopOrderMinAmount,
        plan,
        readOnly,
        rowLimit: MAX_TABLE_ROWS,
        product: product
            ? {
                title: product.title,
                handle: product.handle,
                imageUrl: product.imageUrl,
                variantCount: product.variantCount,
            }
            : null,
        table: table
            ? {
                enabled: table.enabled,
                layout: table.layout,
                orderMinAmount: table.orderMinAmount,
                rules: table.rules,
            }
            : null,
        variants: variants.map((variant) => ({
            id: variant.id,
            label: variant.title,
            sku: variant.sku,
        })),
    };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const productId = decodeURIComponent(params.productId ?? "");
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "save");

    if (intent === "delete") {
        try {
            await deleteProductTable({ admin, shop: session.shop, productId });
            return { ok: true as const, intent, deleted: true };
        } catch (error) {
            console.error("[tablely] deleteProductTable failed:", error);
            return { ok: false as const, intent, errorKey: "error.deleteFailed" };
        }
    }

    if (intent === "save-template") {
        try {
            const created = await saveTemplateFromProduct({
                shop: session.shop,
                productId,
                name: String(formData.get("templateName") ?? ""),
            });
            return { ok: true as const, intent, templateName: created.name };
        } catch (error) {
            if (isTablelyError(error)) {
                return { ok: false as const, intent, errorKey: error.key, field: error.field };
            }
            console.error("[tablely] saveTemplateFromProduct failed:", error);
            return { ok: false as const, intent, errorKey: "error.saveFailed" };
        }
    }

    // 变体规则按「表单里真实提交的变体 id」逐个取，不信任前端的行顺序
    const variantGids = formData.getAll("variantId").map((value) => String(value));
    const rules = variantGids.map((gid) => {
        const key = numericId(gid);
        return {
            variantId: gid,
            min: String(formData.get(`min-${key}`) ?? ""),
            max: String(formData.get(`max-${key}`) ?? ""),
            step: String(formData.get(`step-${key}`) ?? ""),
        };
    });

    const layoutRaw = String(formData.get("layout") ?? "").trim();

    try {
        await saveProductTable({
            admin,
            shop: session.shop,
            productId,
            enabled: formData.get("enabled") === "on",
            layout: layoutRaw === "" || layoutRaw === "inherit" ? null : layoutRaw,
            orderMinAmount: String(formData.get("orderMinAmount") ?? ""),
            rules,
        });
        return { ok: true as const, intent: "save", saved: true };
    } catch (error) {
        if (isTablelyError(error)) {
            return { ok: false as const, intent: "save", errorKey: error.key, field: error.field };
        }
        console.error("[tablely] saveProductTable failed:", error);
        return { ok: false as const, intent: "save", errorKey: "error.saveFailed" };
    }
};

type RuleState = { min: string; max: string; step: string };

/** Free 下显示的「Pro 功能」提示：徽章 + 升级链接（§19.3） */
function ProHint({ label, upgrade }: { label: string; upgrade: string }) {
    return (
        <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">{label}</s-badge>
            <s-link href="/app/plans">{upgrade}</s-link>
        </s-stack>
    );
}

export default function TableDrawer() {
    const {
        locale,
        currency,
        shopOrderMinAmount,
        plan,
        readOnly,
        rowLimit,
        product,
        table,
        variants,
    } = useLoaderData<typeof loader>();
    const t = getT(locale);
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const shopify = useAppBridge();

    const canLayout = hasFeature(plan, "layout_non_table");
    const canOrderMin = hasFeature(plan, "order_minimum");
    const canTemplate = hasFeature(plan, "layout_templates");
    // 只读：降级超限商品整表锁定（仍可关闭启用以释放额度）
    const locked = readOnly;

    const saveFetcher = useFetcher<typeof action>();
    const deleteFetcher = useFetcher<typeof action>();
    const templateFetcher = useFetcher<typeof action>();

    const [enabledOn, setEnabledOn] = useState(table?.enabled ?? true);
    const [layout, setLayout] = useState(table?.layout ?? "inherit");
    const [orderMin, setOrderMin] = useState(table?.orderMinAmount ?? "");
    const [rules, setRules] = useState<Record<string, RuleState>>(() => {
        const byVariant = new Map(
            (table?.rules ?? []).map((rule) => [rule.variantId, rule] as const),
        );
        return Object.fromEntries(
            variants.map((variant) => {
                const rule = byVariant.get(variant.id);
                return [
                    variant.id,
                    {
                        min: rule ? String(rule.min) : "1",
                        max: rule?.max === null || rule?.max === undefined ? "" : String(rule.max),
                        step: rule ? String(rule.step) : "1",
                    },
                ];
            }),
        );
    });
    const [templateName, setTemplateName] = useState("");
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    // 保存失败 → Loader 会重跑，但组件不重挂载；用 ref 判断是否换了商品，避免把商家在填的内容清掉
    const lastProductRef = useRef(table);
    useEffect(() => {
        if (lastProductRef.current === table) return;
        lastProductRef.current = table;
        setEnabledOn(table?.enabled ?? true);
        setLayout(table?.layout ?? "inherit");
        setOrderMin(table?.orderMinAmount ?? "");
        const byVariant = new Map(
            (table?.rules ?? []).map((rule) => [rule.variantId, rule] as const),
        );
        setRules(
            Object.fromEntries(
                variants.map((variant) => {
                    const rule = byVariant.get(variant.id);
                    return [
                        variant.id,
                        {
                            min: rule ? String(rule.min) : "1",
                            max:
                                rule?.max === null || rule?.max === undefined
                                    ? ""
                                    : String(rule.max),
                            step: rule ? String(rule.step) : "1",
                        },
                    ];
                }),
            ),
        );
        setConfirmingDelete(false);
    }, [table, variants]);

    const close = () => {
        const next = new URLSearchParams(searchParams);
        next.delete("edit");
        const rest = next.toString();
        navigate(`/app/tables${rest ? `?${rest}` : ""}`);
    };

    const saveFailed = saveFetcher.data?.ok === false ? saveFetcher.data : null;
    const deleteFailed = deleteFetcher.data?.ok === false ? deleteFetcher.data : null;
    const templateFailed = templateFetcher.data?.ok === false ? templateFetcher.data : null;
    const errorKey =
        saveFailed?.errorKey ?? deleteFailed?.errorKey ?? templateFailed?.errorKey ?? null;

    useEffect(() => {
        if (saveFetcher.data?.ok && saveFetcher.data.intent === "save") {
            shopify.toast.show(t("toast.saved"));
            close();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [saveFetcher.data]);

    useEffect(() => {
        if (deleteFetcher.data?.ok && deleteFetcher.data.intent === "delete") {
            shopify.toast.show(t("toast.deleted"));
            close();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deleteFetcher.data]);

    useEffect(() => {
        if (templateFetcher.data?.ok && templateFetcher.data.intent === "save-template") {
            shopify.toast.show(t("toast.templateSaved"));
            setTemplateName("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [templateFetcher.data]);

    const busy =
        saveFetcher.state !== "idle" ||
        deleteFetcher.state !== "idle" ||
        templateFetcher.state !== "idle";

    const updateRule = (variantId: string, patch: Partial<RuleState>) =>
        setRules((prev) => ({
            ...prev,
            [variantId]: { ...(prev[variantId] ?? { min: "1", max: "", step: "1" }), ...patch },
        }));

    const inheritHint =
        orderMin.trim() === "" && shopOrderMinAmount
            ? t("drawer.orderMinInherit", { amount: shopOrderMinAmount })
            : null;

    return (
        <div
            style={{
                position: "fixed",
                inset: 0,
                zIndex: 100,
                display: "flex",
                justifyContent: "flex-end",
            }}
        >
            {/* 遮罩：用原生 button 保证键盘可达（ESC 之外的「点击空白关闭」） */}
            <button
                type="button"
                aria-label={t("drawer.close")}
                onClick={close}
                style={{
                    position: "absolute",
                    inset: 0,
                    background: "rgba(0, 0, 0, 0.35)",
                    border: "none",
                    padding: 0,
                    cursor: "default",
                }}
            />

            <div
                role="dialog"
                aria-modal="true"
                aria-label={t("drawer.heading")}
                style={{
                    position: "relative",
                    width: "min(560px, 100%)",
                    height: "100%",
                    background: "#ffffff",
                    boxShadow: "-2px 0 14px rgba(0, 0, 0, 0.18)",
                    display: "flex",
                    flexDirection: "column",
                    overflowY: "auto",
                }}
            >
                <div style={{ padding: "16px 20px", borderBottom: "1px solid #e1e3e5" }}>
                    <s-stack
                        direction="inline"
                        gap="base"
                        alignItems="center"
                        justifyContent="space-between"
                    >
                        <s-stack direction="block" gap="none">
                            <s-text type="strong">
                                {product?.title ?? t("drawer.notFound")}
                            </s-text>
                            <s-text color="subdued">{t("drawer.heading")}</s-text>
                        </s-stack>
                        <s-button variant="tertiary" onClick={close}>
                            {t("drawer.close")}
                        </s-button>
                    </s-stack>
                </div>

                {!product ? (
                    <div style={{ padding: "16px 20px" }}>
                        <s-stack direction="block" gap="base">
                            <s-text type="strong">{t("drawer.notFound")}</s-text>
                            <s-text color="subdued">{t("drawer.notFoundBody")}</s-text>
                        </s-stack>
                    </div>
                ) : (
                    <saveFetcher.Form method="post" style={{ padding: "16px 20px" }}>
                        <input type="hidden" name="intent" value="save" />

                        <s-stack direction="block" gap="large">
                            {errorKey ? <s-banner tone="critical">{t(errorKey)}</s-banner> : null}

                            {locked ? (
                                <s-banner tone="warning">
                                    {t("drawer.readOnly")}{" "}
                                    <s-link href="/app/plans">{t("pro.upgrade")}</s-link>
                                </s-banner>
                            ) : null}

                            <s-switch
                                name="enabled"
                                label={t("drawer.enabled")}
                                checked={enabledOn}
                                onChange={(event) => setEnabledOn(checkedOf(event))}
                            />

                            <s-stack direction="block" gap="small">
                                <s-select
                                    name="layout"
                                    label={t("drawer.layout")}
                                    value={layout}
                                    disabled={locked}
                                    onChange={(event) => setLayout(valueOf(event))}
                                >
                                    <s-option value="inherit">{t("layout.inherit")}</s-option>
                                    {LAYOUTS.map((item) => (
                                        <s-option
                                            key={item}
                                            value={item}
                                            disabled={!canLayout && isProLayout(item)}
                                        >
                                            {t(`layout.${item}`)}
                                        </s-option>
                                    ))}
                                </s-select>
                                {!canLayout ? (
                                    <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                                ) : null}
                            </s-stack>

                            <s-stack direction="block" gap="small">
                                <s-number-field
                                    name="orderMinAmount"
                                    label={t("drawer.orderMin")}
                                    value={orderMin}
                                    min={0}
                                    step={0.01}
                                    suffix={currency}
                                    disabled={locked || !canOrderMin}
                                    onChange={(event) => setOrderMin(valueOf(event))}
                                />
                                <s-text color="subdued">{t("drawer.orderMinHint")}</s-text>
                                {inheritHint ? (
                                    <s-text color="subdued">{inheritHint}</s-text>
                                ) : null}
                                {!canOrderMin ? (
                                    <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                                ) : null}
                            </s-stack>

                            <s-divider />

                            <s-stack direction="block" gap="small">
                                <s-heading>{t("drawer.rules")}</s-heading>
                                <s-text color="subdued">{t("drawer.rulesHint")}</s-text>
                                {variants.length > rowLimit ? (
                                    <s-banner tone="warning">
                                        {t("tables.tooManyVariants", { n: rowLimit })}
                                    </s-banner>
                                ) : null}
                            </s-stack>

                            {variants.map((variant) => {
                                const rule = rules[variant.id] ?? {
                                    min: "1",
                                    max: "",
                                    step: "1",
                                };
                                const key = numericId(variant.id);
                                return (
                                    <s-box
                                        key={variant.id}
                                        padding="base"
                                        border="base"
                                        borderRadius="base"
                                    >
                                        <s-stack direction="block" gap="base">
                                            <input
                                                type="hidden"
                                                name="variantId"
                                                value={variant.id}
                                            />
                                            <s-text type="strong">
                                                {variant.sku
                                                    ? `${variant.label} · ${variant.sku}`
                                                    : variant.label}
                                            </s-text>
                                            <s-grid
                                                gridTemplateColumns="1fr 1fr 1fr"
                                                gap="base"
                                            >
                                                <s-number-field
                                                    name={`min-${key}`}
                                                    label={t("drawer.rule.min")}
                                                    value={rule.min}
                                                    min={1}
                                                    step={1}
                                                    disabled={locked}
                                                    onChange={(event) =>
                                                        updateRule(variant.id, {
                                                            min: valueOf(event),
                                                        })
                                                    }
                                                />
                                                <s-number-field
                                                    name={`max-${key}`}
                                                    label={t("drawer.rule.max")}
                                                    value={rule.max}
                                                    min={1}
                                                    step={1}
                                                    disabled={locked}
                                                    onChange={(event) =>
                                                        updateRule(variant.id, {
                                                            max: valueOf(event),
                                                        })
                                                    }
                                                />
                                                <s-number-field
                                                    name={`step-${key}`}
                                                    label={t("drawer.rule.step")}
                                                    value={rule.step}
                                                    min={1}
                                                    step={1}
                                                    disabled={locked}
                                                    onChange={(event) =>
                                                        updateRule(variant.id, {
                                                            step: valueOf(event),
                                                        })
                                                    }
                                                />
                                            </s-grid>
                                        </s-stack>
                                    </s-box>
                                );
                            })}

                            <s-divider />

                            {/* B12：把当前商品配置存成命名模板，供 Tables 页按范围套用到其它商品 */}
                            <s-stack direction="block" gap="small">
                                <s-heading>{t("drawer.saveAsTemplate")}</s-heading>
                                <s-text color="subdued">{t("drawer.saveAsTemplateHint")}</s-text>
                                <s-text-field
                                    name="templateName"
                                    label={t("templates.name")}
                                    value={templateName}
                                    disabled={locked || !canTemplate}
                                    onChange={(event) => setTemplateName(valueOf(event))}
                                />
                                <s-stack direction="inline" gap="base">
                                    <s-button
                                        type="button"
                                        disabled={
                                            locked ||
                                            !canTemplate ||
                                            templateFetcher.state !== "idle"
                                        }
                                        onClick={() =>
                                            templateFetcher.submit(
                                                {
                                                    intent: "save-template",
                                                    templateName,
                                                },
                                                { method: "post" },
                                            )
                                        }
                                    >
                                        {t("templates.create")}
                                    </s-button>
                                </s-stack>
                                {!canTemplate ? (
                                    <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                                ) : null}
                            </s-stack>

                            <s-divider />

                            <s-stack direction="inline" gap="base">
                                <s-button
                                    variant="primary"
                                    type="submit"
                                    disabled={busy || confirmingDelete}
                                >
                                    {t("drawer.save")}
                                </s-button>
                                <s-button
                                    variant="tertiary"
                                    tone="critical"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => {
                                        if (!confirmingDelete) {
                                            setConfirmingDelete(true);
                                            return;
                                        }
                                        deleteFetcher.submit(
                                            { intent: "delete" },
                                            { method: "post" },
                                        );
                                    }}
                                >
                                    {confirmingDelete
                                        ? t("drawer.deleteConfirm")
                                        : t("drawer.delete")}
                                </s-button>
                            </s-stack>
                        </s-stack>
                    </saveFetcher.Form>
                )}
            </div>
        </div>
    );
}