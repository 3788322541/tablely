import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
    Form,
    Outlet,
    useFetcher,
    useLoaderData,
    useSearchParams,
} from "react-router";
import { useEffect, useMemo, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { hasFeature } from "../plan";
import { ADMIN_PAGE_SIZE, CSV_MAX_ROWS } from "../perf-limits";
import { PROXY_SUBPATH } from "../proxy-paths";
import { importCsv } from "../services/csvImport.server";
import { buildQuotePublicUrl, createQuote } from "../services/quotes.server";
import {
    addProductTables,
    countEnabledTables,
    getProductRefsByIds,
    getShopCurrency,
    getShopOrderMinAmount,
    isTablelyError,
    listProductTables,
    listProducts,
    listReadOnlyProductIds,
    maxTablesForPlan,
    resolvePlan,
    saveShopOrderMinAmount,
    setProductTableEnabled,
} from "../services/tables.server";
import {
    applyTemplate,
    deleteTemplate,
    listCollections,
    listTemplates,
    setDefaultTemplate,
} from "../services/templates.server";

/**
 * Tables（M3）—— 订购表列表 + 店铺级起订金额 + 布局模板 + 商品选择
 *
 * 差异化要求（方案 §1.6）：先搜索再操作，IndexTable + 右侧 Drawer（Drawer 在本路由的
 * 子路由 `app.tables.$productId.tsx`，`?edit=` 控制），不照抄竞品的「弹窗挑商品 + 页内大表格」。
 *
 * 两个**不同**的空态（§6.1 / §十二 验收 25）：
 *   - 一个商品都没配 → 「从商品里挑一个开始」（主按钮「选择商品」）；
 *   - 有配置但搜索命中 0 → 「没有匹配的商品」（主按钮「清除筛选」）。
 * 加载态与错误态不复用空态。
 *
 * ⚠️ Pro 门控（整单起订金额 / 非 table 布局 / CSV / 布局模板）按方案归 **M9 付费墙**；
 * 本里程碑只落「可配、可保存」，不提前实现「Free 禁用 + Pro 徽章」。
 */

type TableRowView = {
    productId: string;
    title: string;
    handle: string;
    imageUrl: string | null;
    variantCount: number;
    enabled: boolean;
    layout: string | null;
    orderMinAmount: string | null;
    ruleCount: number;
    updatedAt: string;
    /** 降级后超限只读（§1.6）：仅 Free 且已启用超额时为 true */
    readOnly: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const locale = localeFromRequest(request);

    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() ?? "";
    const pageParam = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
    const pick = url.searchParams.get("pick") === "1";

    const plan = await resolvePlan(session.shop);
    const limit = maxTablesForPlan(plan);

    const [used, allRows, templates, collections, currency, shopOrderMinAmount, readOnlyIds] =
        await Promise.all([
            countEnabledTables(session.shop),
            // 只取商品 id 列表用于「有没有配置」与搜索交集；标题走 Admin API
            listProductTables({ shop: session.shop, take: 1000, skip: 0 }),
            listTemplates(session.shop),
            listCollections(admin),
            getShopCurrency(admin),
            getShopOrderMinAmount(session.shop),
            listReadOnlyProductIds(session.shop),
        ]);

    // 关键词搜索：标题不在本应用库里（§四 未存 title），先用 Admin API 搜出命中 id 再与库内求交集。
    // 这样「有配置但命中 0」与「一个都没配」能被区分开，对应两个不同空态。
    const matchedIds = query
        ? (await listProducts(admin, { query, first: 250 })).items.map((item) => item.id)
        : null;

    const filtered = matchedIds
        ? allRows.items.filter((item) => matchedIds.includes(item.productId))
        : allRows.items;

    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
    const safePage = Math.min(page, pageCount);
    const pageRows = filtered.slice(
        (safePage - 1) * ADMIN_PAGE_SIZE,
        safePage * ADMIN_PAGE_SIZE,
    );

    const refs = await getProductRefsByIds(
        admin,
        pageRows.map((row) => row.productId),
    );
    const refMap = new Map(refs.map((ref) => [ref.id, ref]));

    const rows: TableRowView[] = pageRows.map((row) => {
        const ref = refMap.get(row.productId);
        return {
            productId: row.productId,
            title: ref?.title ?? "",
            handle: ref?.handle ?? "",
            imageUrl: ref?.imageUrl ?? null,
            variantCount: ref?.variantCount ?? 0,
            enabled: row.enabled,
            layout: row.layout,
            orderMinAmount: row.orderMinAmount,
            ruleCount: row.ruleCount,
            updatedAt: row.updatedAt.toISOString(),
            readOnly: readOnlyIds.has(row.productId),
        };
    });

    // 「选择商品」浮层：已配置的商品要打勾并禁用（避免重复添加）
    const configuredSet = new Set(allRows.items.map((item) => item.productId));
    const pickProducts = pick
        ? (await listProducts(admin, { query: query || undefined, first: 50 })).items.map(
            (item) => ({ ...item, configured: configuredSet.has(item.id) }),
        )
        : [];

    return {
        locale,
        shop: session.shop,
        query,
        page: safePage,
        pageCount,
        pick,
        currency,
        shopOrderMinAmount,
        plan,
        quota: { used, limit, overLimit: used > limit },
        totalConfigured: allRows.total,
        rows,
        templates,
        collections,
        pickProducts,
    };
};

export const action = async ({ request }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "");

    try {
        if (intent === "save-shop-min") {
            const value = await saveShopOrderMinAmount(
                session.shop,
                String(formData.get("orderMinAmount") ?? ""),
            );
            return { ok: true as const, intent: "save-shop-min" as const, value };
        }

        if (intent === "add-products") {
            const created = await addProductTables({
                shop: session.shop,
                productIds: formData.getAll("productId").map((value) => String(value)),
            });
            return { ok: true as const, intent: "add-products" as const, created };
        }

        if (intent === "toggle-enabled") {
            await setProductTableEnabled({
                shop: session.shop,
                productId: String(formData.get("productId") ?? ""),
                enabled: formData.get("enabled") === "on",
            });
            return { ok: true as const, intent: "toggle-enabled" as const };
        }

        if (intent === "set-default-template") {
            await setDefaultTemplate({
                shop: session.shop,
                templateId: String(formData.get("templateId") ?? ""),
                isDefault: formData.get("isDefault") === "on",
            });
            return { ok: true as const, intent: "set-default-template" as const };
        }

        if (intent === "delete-template") {
            await deleteTemplate({
                shop: session.shop,
                templateId: String(formData.get("templateId") ?? ""),
            });
            return { ok: true as const, intent: "delete-template" as const };
        }

        if (intent === "import-csv") {
            const file = formData.get("file");
            if (!(file instanceof File) || file.size === 0) {
                return { ok: false as const, intent, errorKey: "csv.empty" };
            }
            const csvText = await file.text();
            const result = await importCsv({
                admin,
                shop: session.shop,
                csvText,
            });
            return { ok: true as const, intent: "import-csv" as const, result };
        }

        if (intent === "create-quote") {
            const productIds = formData.getAll("productId").map((value) => String(value));
            if (productIds.length === 0) {
                return { ok: false as const, intent, errorKey: "quote.selectProducts" };
            }
            const currency = await getShopCurrency(admin);
            const created = await createQuote({
                shop: session.shop,
                admin,
                productIds,
                currency,
                note: String(formData.get("note") ?? ""),
                validDays: formData.get("validDays"),
                customerId: String(formData.get("customerId") ?? ""),
            });
            if (!created) {
                return { ok: false as const, intent, errorKey: "quote.selectProducts" };
            }
            return {
                ok: true as const,
                intent: "create-quote" as const,
                token: created.token,
                url: buildQuotePublicUrl(session.shop, created.token),
            };
        }

        if (intent === "apply-template") {
            const result = await applyTemplate({
                admin,
                shop: session.shop,
                templateId: String(formData.get("templateId") ?? ""),
                scope: String(formData.get("scope") ?? "all") as
                    | "all"
                    | "collection"
                    | "selected",
                collectionId: String(formData.get("collectionId") ?? ""),
                productIds: formData.getAll("productId").map((value) => String(value)),
                overwriteRules: formData.get("overwriteRules") === "on",
            });
            return { ok: true as const, intent: "apply-template" as const, result };
        }

        return { ok: false as const, intent, errorKey: "error.saveFailed" };
    } catch (error) {
        if (isTablelyError(error)) {
            return { ok: false as const, intent, errorKey: error.key, field: error.field };
        }
        console.error("[tablely] tables action failed:", error);
        return { ok: false as const, intent, errorKey: "error.saveFailed" };
    }
};

const EMDASH = "—";

/** Free 下显示的「Pro 功能」提示：徽章 + 升级链接（§19.3） */
function ProHint({ label, upgrade }: { label: string; upgrade: string }) {
    return (
        <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">{label}</s-badge>
            <s-link href="/app/plans">{upgrade}</s-link>
        </s-stack>
    );
}

const cellText: React.CSSProperties = {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
};

const valueOf = (event: Event): string =>
    String((event.currentTarget as unknown as { value?: string } | null)?.value ?? "");
const checkedOf = (event: Event): boolean =>
    Boolean((event.currentTarget as unknown as { checked?: boolean } | null)?.checked);

export default function TablesPage() {
    const {
        locale,
        shop,
        query,
        page,
        pageCount,
        pick,
        currency,
        shopOrderMinAmount,
        plan,
        quota,
        totalConfigured,
        rows,
        templates,
        collections,
        pickProducts,
    } = useLoaderData<typeof loader>();
    const t = getT(locale);
    const [searchParams, setSearchParams] = useSearchParams();
    const shopify = useAppBridge();

    const canOrderMinimum = hasFeature(plan, "order_minimum");
    const canTemplates = hasFeature(plan, "layout_templates");
    const canCsv = hasFeature(plan, "csv");
    const canQuote = hasFeature(plan, "quote");

    const shopMinFetcher = useFetcher<typeof action>();
    const addFetcher = useFetcher<typeof action>();
    const toggleFetcher = useFetcher<typeof action>();
    const templateFetcher = useFetcher<typeof action>();
    const csvFetcher = useFetcher<typeof action>();
    const quoteFetcher = useFetcher<typeof action>();

    const [searchInput, setSearchInput] = useState(query);
    const [shopMin, setShopMin] = useState(shopOrderMinAmount ?? "");
    const [selected, setSelected] = useState<string[]>([]);
    const [pickSelection, setPickSelection] = useState<string[]>([]);
    const [applyTemplateId, setApplyTemplateId] = useState(templates[0]?.id ?? "");
    const [applyScope, setApplyScope] = useState<"all" | "collection" | "selected">("all");
    const [applyCollection, setApplyCollection] = useState("");
    const [overwriteRules, setOverwriteRules] = useState(false);
    const [quoteCustomerId, setQuoteCustomerId] = useState("");
    const [quoteNote, setQuoteNote] = useState("");
    const [quoteValidDays, setQuoteValidDays] = useState("7");

    useEffect(() => {
        setShopMin(shopOrderMinAmount ?? "");
    }, [shopOrderMinAmount]);

    useEffect(() => {
        setSearchInput(query);
    }, [query]);

    const setParams = (patch: Record<string, string | null>) => {
        const next = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === "") next.delete(key);
            else next.set(key, value);
        }
        setSearchParams(next);
    };

    const closePick = () => setParams({ pick: null });
    const openPick = () => {
        setPickSelection([]);
        setParams({ pick: "1" });
    };

    const addFailed = addFetcher.data?.ok === false ? addFetcher.data : null;
    const templateFailed = templateFetcher.data?.ok === false ? templateFetcher.data : null;
    const shopMinFailed = shopMinFetcher.data?.ok === false ? shopMinFetcher.data : null;

    useEffect(() => {
        if (addFetcher.data?.ok && addFetcher.data.intent === "add-products") {
            shopify.toast.show(t("toast.added", { n: addFetcher.data.created }));
            setPickSelection([]);
            closePick();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addFetcher.data]);

    useEffect(() => {
        if (shopMinFetcher.data?.ok && shopMinFetcher.data.intent === "save-shop-min") {
            shopify.toast.show(t("toast.saved"));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shopMinFetcher.data]);

    useEffect(() => {
        if (templateFetcher.data?.ok && templateFetcher.data.intent === "set-default-template") {
            shopify.toast.show(t("toast.updated"));
        }
        if (templateFetcher.data?.ok && templateFetcher.data.intent === "delete-template") {
            shopify.toast.show(t("toast.deleted"));
        }
        if (templateFetcher.data?.ok && templateFetcher.data.intent === "apply-template") {
            shopify.toast.show(
                t("toast.templateApplied", { n: templateFetcher.data.result.applied }),
            );
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [templateFetcher.data]);

    useEffect(() => {
        if (toggleFetcher.data?.ok && toggleFetcher.data.intent === "toggle-enabled") {
            shopify.toast.show(t("toast.updated"));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [toggleFetcher.data]);

    const allOnPageSelected =
        rows.length > 0 && rows.every((row) => selected.includes(row.productId));

    const toggleRow = (productId: string, checked: boolean) =>
        setSelected((prev) =>
            checked ? [...new Set([...prev, productId])] : prev.filter((id) => id !== productId),
        );

    const dateFormat = useMemo(
        () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
        [locale],
    );

    const applyResult =
        templateFetcher.data?.ok && templateFetcher.data.intent === "apply-template"
            ? templateFetcher.data.result
            : null;

    // CSV 导入结果（成功 / 失败两态）与下载入口
    const csvData = csvFetcher.data;
    const csvResult =
        csvData && csvData.ok && csvData.intent === "import-csv" ? csvData.result : null;
    const csvActionError =
        csvData && csvData.ok === false && csvData.intent === "import-csv" ? csvData : null;

    // 报价单生成结果（Y17 / §15.8）：成功展示 token 链接，失败给可读原因
    const quoteData = quoteFetcher.data;
    const quoteResult =
        quoteData && quoteData.ok && quoteData.intent === "create-quote" ? quoteData : null;
    const quoteError =
        quoteData && quoteData.ok === false && quoteData.intent === "create-quote"
            ? quoteData
            : null;

    useEffect(() => {
        if (quoteResult) shopify.toast.show(t("quote.created"));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [quoteResult]);

    /**
     * 下载与补货页都**在新标签页打开**：CSV 是资源路由（`Content-Disposition: attachment`），
     * 新标签页是顶层文档，既不会被 App Bridge 的嵌入导航拦截，也不受 iframe 下载限制。
     */
    const openExternal = (url: string) =>
        window.open(url, "_blank", "noopener,noreferrer");

    const importCsvFile = (event: React.ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = ""; // 允许重复选择同一文件
        if (!file) return;
        const data = new FormData();
        data.append("intent", "import-csv");
        data.append("file", file);
        csvFetcher.submit(data, { method: "post", encType: "multipart/form-data" });
    };

    const quickOrderUrl = `https://${shop}${PROXY_SUBPATH}/quick-order`;

    /** 复制报价单链接（失败静默：链接在页面上仍可手动选中复制） */
    const copyQuoteLink = (url: string) => {
        navigator.clipboard
            ?.writeText(url)
            .then(() => shopify.toast.show(t("toast.copied")))
            .catch(() => {});
    };

    const noData = totalConfigured === 0;
    const noMatch = !noData && rows.length === 0;

    return (
        <s-page heading={t("tables.title")}>
            {/* ① 店铺级默认整单起订金额（Y14；商品级可覆写，见 Drawer） */}
            <s-section heading={t("tables.shopDefault")}>
                <shopMinFetcher.Form method="post">
                    <input type="hidden" name="intent" value="save-shop-min" />
                    <s-stack direction="block" gap="base">
                        {shopMinFailed ? (
                            <s-banner tone="critical">{t(shopMinFailed.errorKey)}</s-banner>
                        ) : null}
                        <s-number-field
                            name="orderMinAmount"
                            label={t("tables.shopDefaultLabel")}
                            value={shopMin}
                            min={0}
                            step={0.01}
                            suffix={currency}
                            disabled={!canOrderMinimum}
                            onChange={(event) => setShopMin(valueOf(event))}
                        />
                        <s-text color="subdued">{t("tables.shopDefaultHint")}</s-text>
                        {!canOrderMinimum ? (
                            <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                        ) : null}
                        <s-stack direction="inline" gap="base">
                            <s-button
                                type="submit"
                                disabled={
                                    !canOrderMinimum || shopMinFetcher.state !== "idle"
                                }
                            >
                                {t("tables.save")}
                            </s-button>
                        </s-stack>
                    </s-stack>
                </shopMinFetcher.Form>
            </s-section>

            {/* ② 列表 + 搜索 + 额度 */}
            <s-section>
                <s-stack direction="block" gap="base">
                    <s-stack
                        direction="inline"
                        gap="base"
                        alignItems="center"
                        justifyContent="space-between"
                    >
                        <s-text color="subdued">
                            {quota.overLimit
                                ? t("quota.overLimit", {
                                    used: quota.used,
                                    limit: quota.limit,
                                })
                                : t("quota.products", {
                                    used: quota.used,
                                    limit:
                                        quota.limit === Number.POSITIVE_INFINITY
                                            ? "∞"
                                            : quota.limit,
                                })}
                        </s-text>
                        <s-stack direction="inline" gap="base">
                            <s-button onClick={() => openExternal(quickOrderUrl)}>
                                {t("quickOrder.heading")}
                            </s-button>
                            <s-button onClick={openPick}>{t("tables.chooseProducts")}</s-button>
                        </s-stack>
                    </s-stack>

                    <Form method="get">
                        <s-stack direction="inline" gap="base" alignItems="end">
                            <s-search-field
                                label={t("tables.search")}
                                labelAccessibilityVisibility="exclusive"
                                value={searchInput}
                                onChange={(event) => setSearchInput(valueOf(event))}
                            />
                            <input type="hidden" name="q" value={searchInput} />
                            <s-button type="submit">{t("tables.searchAction")}</s-button>
                        </s-stack>
                    </Form>

                    {addFailed ? (
                        <s-banner tone="critical">{t(addFailed.errorKey)}</s-banner>
                    ) : null}

                    {noData ? (
                        <s-empty-state heading={t("empty.tables.title")}>
                            <s-text slot="subheading">{t("empty.tables.body")}</s-text>
                            <s-button
                                slot="primary-action"
                                variant="primary"
                                onClick={openPick}
                            >
                                {t("empty.tables.cta")}
                            </s-button>
                            <s-button
                                slot="secondary-actions"
                                variant="secondary"
                                onClick={() =>
                                    document
                                        .getElementById("tablely-templates")
                                        ?.scrollIntoView({ behavior: "smooth" })
                                }
                            >
                                {t("empty.tables.secondary")}
                            </s-button>
                        </s-empty-state>
                    ) : noMatch ? (
                        <s-empty-state heading={t("empty.search.title")}>
                            <s-button
                                slot="primary-action"
                                variant="primary"
                                onClick={() => {
                                    setSearchInput("");
                                    setParams({ q: null, page: null });
                                }}
                            >
                                {t("empty.search.cta")}
                            </s-button>
                        </s-empty-state>
                    ) : (
                        <s-table>
                            <s-table-header-row>
                                <s-table-header>
                                    <span
                                        onClickCapture={(event) => event.stopPropagation()}
                                    >
                                        <s-checkbox
                                            accessibilityLabel={t("tables.selectAll")}
                                            checked={allOnPageSelected}
                                            onChange={(event) => {
                                                const checked = checkedOf(event);
                                                setSelected(
                                                    checked
                                                        ? rows.map((row) => row.productId)
                                                        : [],
                                                );
                                            }}
                                        />
                                    </span>
                                </s-table-header>
                                <s-table-header listSlot="primary">
                                    {t("tables.col.product")}
                                </s-table-header>
                                <s-table-header>{t("tables.col.status")}</s-table-header>
                                <s-table-header>{t("tables.col.layout")}</s-table-header>
                                <s-table-header>{t("tables.col.rules")}</s-table-header>
                                <s-table-header>{t("tables.col.orderMin")}</s-table-header>
                                <s-table-header>{t("tables.col.updated")}</s-table-header>
                            </s-table-header-row>
                            <s-table-body>
                                {rows.map((row, index) => {
                                    const delegateId = `tablely-open-${index}`;
                                    const params = new URLSearchParams(searchParams);
                                    params.set("edit", row.productId);
                                    return (
                                        <s-table-row key={row.productId} clickDelegate={delegateId}>
                                            <s-table-cell>
                                                <span
                                                    onClickCapture={(event) =>
                                                        event.stopPropagation()
                                                    }
                                                >
                                                    <s-checkbox
                                                        accessibilityLabel={t(
                                                            "tables.selectRow",
                                                        )}
                                                        checked={selected.includes(
                                                            row.productId,
                                                        )}
                                                        onChange={(event) =>
                                                            toggleRow(
                                                                row.productId,
                                                                checkedOf(event),
                                                            )
                                                        }
                                                    />
                                                </span>
                                            </s-table-cell>
                                            <s-table-cell>
                                                <div
                                                    style={{
                                                        display: "flex",
                                                        gap: 8,
                                                        alignItems: "center",
                                                    }}
                                                >
                                                    {row.imageUrl ? (
                                                        <s-thumbnail
                                                            src={row.imageUrl}
                                                            alt={row.title}
                                                            size="small"
                                                        />
                                                    ) : null}
                                                    <s-link
                                                        id={delegateId}
                                                        href={`/app/tables/${encodeURIComponent(
                                                            row.productId,
                                                        )}?${params.toString()}`}
                                                    >
                                                        {row.title || EMDASH}
                                                    </s-link>
                                                </div>
                                            </s-table-cell>
                                            <s-table-cell>
                                                <s-stack direction="inline" gap="small" alignItems="center">
                                                    <s-switch
                                                        accessibilityLabel={t(
                                                            "tables.toggleEnabled",
                                                        )}
                                                        checked={row.enabled}
                                                        onChange={(event) => {
                                                            toggleFetcher.submit(
                                                                {
                                                                    intent: "toggle-enabled",
                                                                    productId: row.productId,
                                                                    enabled: checkedOf(event)
                                                                        ? "on"
                                                                        : "off",
                                                                },
                                                                { method: "post" },
                                                            );
                                                        }}
                                                    />
                                                    {row.readOnly ? (
                                                        <s-badge tone="warning">
                                                            {t("tables.readOnlyBadge")}
                                                        </s-badge>
                                                    ) : null}
                                                </s-stack>
                                            </s-table-cell>
                                            <s-table-cell>
                                                <span style={cellText}>
                                                    {row.layout
                                                        ? t(`layout.${row.layout}`)
                                                        : t("layout.inherit")}
                                                </span>
                                            </s-table-cell>
                                            <s-table-cell>
                                                <span style={cellText}>
                                                    {row.ruleCount > 0
                                                        ? t("tables.rulesCount", {
                                                            n: row.ruleCount,
                                                        })
                                                        : EMDASH}
                                                </span>
                                            </s-table-cell>
                                            <s-table-cell>
                                                <span style={cellText}>
                                                    {row.orderMinAmount ??
                                                        shopOrderMinAmount ??
                                                        EMDASH}
                                                </span>
                                            </s-table-cell>
                                            <s-table-cell>
                                                <span style={cellText}>
                                                    {dateFormat.format(
                                                        new Date(row.updatedAt),
                                                    )}
                                                </span>
                                            </s-table-cell>
                                        </s-table-row>
                                    );
                                })}
                            </s-table-body>
                        </s-table>
                    )}

                    {pageCount > 1 ? (
                        <s-stack
                            direction="inline"
                            gap="base"
                            alignItems="center"
                            justifyContent="end"
                        >
                            <s-button
                                disabled={page <= 1}
                                onClick={() => setParams({ page: String(page - 1) })}
                            >
                                {t("tables.prev")}
                            </s-button>
                            <s-text color="subdued">
                                {t("tables.pageOf", { page, total: pageCount })}
                            </s-text>
                            <s-button
                                disabled={page >= pageCount}
                                onClick={() => setParams({ page: String(page + 1) })}
                            >
                                {t("tables.next")}
                            </s-button>
                        </s-stack>
                    ) : null}
                </s-stack>
            </s-section>

            {/* ③ CSV 模板 / 导出 / 导入（Y16 / §15.6）；导入结果逐行回报 + 错误清单可下载 */}
            <s-section id="tablely-csv" heading={t("csv.title")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("csv.hint")}</s-text>
                    {!canCsv ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    <s-stack direction="inline" gap="base" alignItems="center">
                        <s-button
                            disabled={!canCsv}
                            onClick={() =>
                                openExternal("/app/tables/export?mode=template")
                            }
                        >
                            {t("csv.downloadTemplate")}
                        </s-button>
                        <s-button
                            disabled={!canCsv}
                            onClick={() => openExternal("/app/tables/export?mode=export")}
                        >
                            {t("csv.export")}
                        </s-button>
                        <label>
                            <s-text color="subdued">{t("csv.import")}</s-text>
                            <input
                                type="file"
                                accept=".csv,text/csv"
                                disabled={!canCsv || csvFetcher.state !== "idle"}
                                aria-label={t("csv.chooseFile")}
                                onChange={importCsvFile}
                                style={{ display: "block", marginTop: 4 }}
                            />
                        </label>
                    </s-stack>

                    {csvActionError ? (
                        <s-banner tone="critical">{t(csvActionError.errorKey)}</s-banner>
                    ) : null}

                    {csvResult ? (
                        csvResult.ok ? (
                            <s-stack direction="block" gap="small">
                                <s-banner
                                    tone={csvResult.failed > 0 ? "warning" : "success"}
                                >
                                    {t("csv.importResult", {
                                        ok: csvResult.imported,
                                        fail: csvResult.failed,
                                    })}
                                </s-banner>
                                {csvResult.errors.length > 0 ? (
                                    <s-stack direction="block" gap="small">
                                        <s-text color="subdued">
                                            {t("csv.firstErrors", {
                                                n: Math.min(20, csvResult.errors.length),
                                            })}
                                        </s-text>
                                        {csvResult.errors
                                            .slice(0, 20)
                                            .map((row, index) => (
                                                <s-text key={`${row.line}-${index}`} color="subdued">
                                                    {`#${row.line} ${row.sku || "—"} · ${t(row.error)}`}
                                                </s-text>
                                            ))}
                                        {csvResult.errorToken ? (
                                            <s-stack direction="inline" gap="base">
                                                <s-button
                                                    variant="tertiary"
                                                    onClick={() =>
                                                        openExternal(
                                                            `/app/tables/export?mode=errors&token=${encodeURIComponent(
                                                                csvResult.errorToken ?? "",
                                                            )}`,
                                                        )
                                                    }
                                                >
                                                    {t("csv.downloadErrors")}
                                                </s-button>
                                            </s-stack>
                                        ) : null}
                                    </s-stack>
                                ) : null}
                            </s-stack>
                        ) : (
                            <s-banner tone="critical">
                                {csvResult.code === "header"
                                    ? t(csvResult.headerError)
                                    : t(
                                          csvResult.violation === "rows"
                                              ? "perf.tooManyRows"
                                              : "perf.csvTooLarge",
                                          {
                                              n:
                                                  csvResult.violation === "rows"
                                                      ? csvResult.limit
                                                      : CSV_MAX_ROWS,
                                          },
                                      )}
                            </s-banner>
                        )
                    ) : null}
                </s-stack>
            </s-section>

            {/* ④ 报价单（Y17 / §15.8）：选中商品 → 实时取价快照 → 打印视图链接 */}
            <s-section id="tablely-quote" heading={t("quote.title")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("quote.hint")}</s-text>
                    {!canQuote ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}
                    {quoteError ? (
                        <s-banner tone="critical">{t(quoteError.errorKey)}</s-banner>
                    ) : null}
                    <s-text color="subdued">
                        {t("templates.selectedHint", { n: selected.length })}
                    </s-text>
                    <s-stack direction="inline" gap="base" alignItems="center">
                        <s-text-field
                            label={t("quote.customerId")}
                            value={quoteCustomerId}
                            disabled={!canQuote}
                            onChange={(event) => setQuoteCustomerId(valueOf(event))}
                        />
                        <s-number-field
                            label={t("quote.validDays")}
                            value={quoteValidDays}
                            min={1}
                            max={90}
                            disabled={!canQuote}
                            onChange={(event) => setQuoteValidDays(valueOf(event))}
                        />
                    </s-stack>
                    <s-text-field
                        label={t("quote.note")}
                        value={quoteNote}
                        disabled={!canQuote}
                        onChange={(event) => setQuoteNote(valueOf(event))}
                    />
                    <s-stack direction="inline" gap="base">
                        <s-button
                            disabled={
                                !canQuote || selected.length === 0 || quoteFetcher.state !== "idle"
                            }
                            onClick={() =>
                                quoteFetcher.submit(
                                    {
                                        intent: "create-quote",
                                        validDays: quoteValidDays,
                                        customerId: quoteCustomerId,
                                        note: quoteNote,
                                        productId: selected,
                                    },
                                    { method: "post" },
                                )
                            }
                        >
                            {t("quote.generate")}
                        </s-button>
                    </s-stack>
                    {quoteResult ? (
                        <s-stack direction="block" gap="small">
                            <s-banner tone="success">{t("quote.created")}</s-banner>
                            <s-text color="subdued">{quoteResult.url}</s-text>
                            <s-stack direction="inline" gap="base">
                                <s-button
                                    variant="secondary"
                                    onClick={() => copyQuoteLink(quoteResult.url)}
                                >
                                    {t("quote.copyLink")}
                                </s-button>
                                <s-button
                                    variant="secondary"
                                    onClick={() => openExternal(quoteResult.url)}
                                >
                                    {t("quote.open")}
                                </s-button>
                            </s-stack>
                        </s-stack>
                    ) : null}
                </s-stack>
            </s-section>

            {/* ⑤ 布局模板（B12）：保存来自 Drawer；这里负责默认 / 删除 / 按范围套用 */}
            <s-section id="tablely-templates" heading={t("templates.title")}>
                <s-stack direction="block" gap="base">
                    {templateFailed ? (
                        <s-banner tone="critical">{t(templateFailed.errorKey)}</s-banner>
                    ) : null}
                    {!canTemplates ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    {templates.length === 0 ? (
                        <s-stack direction="block" gap="small">
                            <s-text color="subdued">{t("templates.empty")}</s-text>
                        </s-stack>
                    ) : (
                        <s-stack direction="block" gap="base">
                            {templates.map((template) => (
                                <s-box
                                    key={template.id}
                                    padding="base"
                                    border="base"
                                    borderRadius="base"
                                >
                                    <s-stack direction="block" gap="base">
                                        <s-stack
                                            direction="inline"
                                            gap="base"
                                            alignItems="center"
                                            justifyContent="space-between"
                                        >
                                            <s-stack
                                                direction="inline"
                                                gap="base"
                                                alignItems="center"
                                            >
                                                <s-text type="strong">{template.name}</s-text>
                                                {template.isDefault ? (
                                                    <s-badge tone="success">
                                                        {t("templates.defaultBadge")}
                                                    </s-badge>
                                                ) : null}
                                            </s-stack>
                                            <s-stack direction="inline" gap="base">
                                                <s-button
                                                    disabled={!canTemplates}
                                                    onClick={() =>
                                                        templateFetcher.submit(
                                                            {
                                                                intent: "set-default-template",
                                                                templateId: template.id,
                                                                isDefault: template.isDefault
                                                                    ? "off"
                                                                    : "on",
                                                            },
                                                            { method: "post" },
                                                        )
                                                    }
                                                >
                                                    {template.isDefault
                                                        ? t("templates.unsetDefault")
                                                        : t("templates.setDefault")}
                                                </s-button>
                                                <s-button
                                                    variant="tertiary"
                                                    tone="critical"
                                                    disabled={!canTemplates}
                                                    onClick={() =>
                                                        templateFetcher.submit(
                                                            {
                                                                intent: "delete-template",
                                                                templateId: template.id,
                                                            },
                                                            { method: "post" },
                                                        )
                                                    }
                                                >
                                                    {t("templates.delete")}
                                                </s-button>
                                            </s-stack>
                                        </s-stack>
                                        <s-text color="subdued">
                                            {t("templates.summary", {
                                                layout: template.layout
                                                    ? t(`layout.${template.layout}`)
                                                    : t("layout.inherit"),
                                                rules: template.ruleCount,
                                                orderMin:
                                                    template.orderMinAmount ??
                                                    t("tables.notSet"),
                                            })}
                                        </s-text>
                                    </s-stack>
                                </s-box>
                            ))}

                            {/* 套用：范围 = 全部 / 系列 / 勾选商品；默认不覆盖已手改的变体规则 */}
                            <templateFetcher.Form method="post">
                                <input type="hidden" name="intent" value="apply-template" />
                                {selected.map((productId) => (
                                    <input
                                        key={productId}
                                        type="hidden"
                                        name="productId"
                                        value={productId}
                                    />
                                ))}
                                <s-stack direction="block" gap="base">
                                    <s-select
                                        name="templateId"
                                        label={t("templates.pick")}
                                        value={applyTemplateId}
                                        onChange={(event) =>
                                            setApplyTemplateId(valueOf(event))
                                        }
                                    >
                                        {templates.map((template) => (
                                            <s-option key={template.id} value={template.id}>
                                                {template.name}
                                            </s-option>
                                        ))}
                                    </s-select>

                                    <s-select
                                        name="scope"
                                        label={t("templates.scope")}
                                        value={applyScope}
                                        onChange={(event) =>
                                            setApplyScope(
                                                valueOf(event) as "all" | "collection" | "selected",
                                            )
                                        }
                                    >
                                        <s-option value="all">{t("templates.scope.all")}</s-option>
                                        <s-option value="collection">
                                            {t("templates.scope.collection")}
                                        </s-option>
                                        <s-option value="selected">
                                            {t("templates.scope.selected")}
                                        </s-option>
                                    </s-select>

                                    {applyScope === "collection" ? (
                                        <s-select
                                            name="collectionId"
                                            label={t("templates.collection")}
                                            value={applyCollection}
                                            onChange={(event) =>
                                                setApplyCollection(valueOf(event))
                                            }
                                        >
                                            <s-option value="">{t("templates.pickCollection")}</s-option>
                                            {collections.map((collection) => (
                                                <s-option
                                                    key={collection.id}
                                                    value={collection.id}
                                                >
                                                    {collection.title}
                                                </s-option>
                                            ))}
                                        </s-select>
                                    ) : null}

                                    {applyScope === "selected" ? (
                                        <s-text color="subdued">
                                            {t("templates.selectedHint", { n: selected.length })}
                                        </s-text>
                                    ) : null}

                                    <s-checkbox
                                        name="overwriteRules"
                                        value="on"
                                        label={t("templates.overwriteRules")}
                                        checked={overwriteRules}
                                        onChange={(event) =>
                                            setOverwriteRules(checkedOf(event))
                                        }
                                    />
                                    <s-text color="subdued">{t("templates.overwriteHint")}</s-text>

                                    <s-stack direction="inline" gap="base">
                                        <s-button
                                            type="submit"
                                            disabled={
                                                !canTemplates ||
                                                templateFetcher.state !== "idle"
                                            }
                                        >
                                            {t("templates.apply")}
                                        </s-button>
                                    </s-stack>
                                </s-stack>
                            </templateFetcher.Form>

                            {applyResult ? (
                                <s-banner
                                    tone={applyResult.overflow > 0 ? "warning" : "success"}
                                >
                                    {t("templates.applied", { n: applyResult.applied })}
                                    {applyResult.overflow > 0
                                        ? ` ${t("templates.overflow", {
                                            n: applyResult.overflow,
                                            limit: applyResult.limit,
                                        })}`
                                        : ""}
                                </s-banner>
                            ) : null}
                        </s-stack>
                    )}
                </s-stack>
            </s-section>

            {/* ⑥ 选择商品浮层（?pick=1） */}
            {pick ? (
                <div
                    style={{
                        position: "fixed",
                        inset: 0,
                        zIndex: 100,
                        display: "flex",
                        justifyContent: "flex-end",
                    }}
                >
                    {/* 遮罩：用原生 button 保证键盘可达 */}
                    <button
                        type="button"
                        aria-label={t("pick.cancel")}
                        onClick={closePick}
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
                        aria-label={t("pick.heading")}
                        style={{
                            position: "relative",
                            width: "min(520px, 100%)",
                            height: "100%",
                            background: "#ffffff",
                            boxShadow: "-2px 0 14px rgba(0, 0, 0, 0.18)",
                            display: "flex",
                            flexDirection: "column",
                        }}
                    >
                        <div
                            style={{
                                padding: "16px 20px",
                                borderBottom: "1px solid #e1e3e5",
                            }}
                        >
                            <s-stack
                                direction="inline"
                                gap="base"
                                alignItems="center"
                                justifyContent="space-between"
                            >
                                <s-text type="strong">{t("pick.heading")}</s-text>
                                <s-button variant="tertiary" onClick={closePick}>
                                    {t("pick.cancel")}
                                </s-button>
                            </s-stack>
                        </div>

                        <addFetcher.Form
                            method="post"
                            style={{
                                flex: 1,
                                display: "flex",
                                flexDirection: "column",
                                minHeight: 0,
                            }}
                        >
                            <input type="hidden" name="intent" value="add-products" />
                            {pickSelection.map((productId) => (
                                <input
                                    key={productId}
                                    type="hidden"
                                    name="productId"
                                    value={productId}
                                />
                            ))}

                            <div style={{ padding: "12px 20px" }}>
                                <Form method="get">
                                    <input type="hidden" name="pick" value="1" />
                                    <s-stack direction="inline" gap="base" alignItems="end">
                                        <s-search-field
                                            label={t("pick.search")}
                                            labelAccessibilityVisibility="exclusive"
                                            value={searchInput}
                                            onChange={(event) =>
                                                setSearchInput(valueOf(event))
                                            }
                                        />
                                        <input type="hidden" name="q" value={searchInput} />
                                        <s-button type="submit">
                                            {t("tables.searchAction")}
                                        </s-button>
                                    </s-stack>
                                </Form>
                            </div>

                            <div style={{ flex: 1, overflowY: "auto", padding: "0 20px 12px" }}>
                                {pickProducts.length === 0 ? (
                                    <s-text color="subdued">{t("pick.empty")}</s-text>
                                ) : (
                                    <s-stack direction="block" gap="base">
                                        {pickProducts.map((product) => (
                                            <s-checkbox
                                                key={product.id}
                                                accessibilityLabel={product.title}
                                                label={
                                                    product.configured
                                                        ? `${product.title} · ${t("pick.already")}`
                                                        : product.title
                                                }
                                                checked={
                                                    product.configured ||
                                                    pickSelection.includes(product.id)
                                                }
                                                disabled={product.configured}
                                                onChange={(event) =>
                                                    setPickSelection((prev) =>
                                                        checkedOf(event)
                                                            ? [...new Set([...prev, product.id])]
                                                            : prev.filter(
                                                                (id) => id !== product.id,
                                                            ),
                                                    )
                                                }
                                            />
                                        ))}
                                    </s-stack>
                                )}
                            </div>

                            <div style={{ padding: "12px 20px", borderTop: "1px solid #e1e3e5" }}>
                                <s-stack direction="inline" gap="base">
                                    <s-button
                                        type="submit"
                                        variant="primary"
                                        disabled={
                                            addFetcher.state !== "idle" ||
                                            pickSelection.length === 0
                                        }
                                    >
                                        {t("pick.add", { n: pickSelection.length })}
                                    </s-button>
                                    <s-button type="button" onClick={closePick}>
                                        {t("pick.cancel")}
                                    </s-button>
                                </s-stack>
                            </div>
                        </addFetcher.Form>
                    </div>
                </div>
            ) : null}

            <Outlet />
        </s-page>
    );
}