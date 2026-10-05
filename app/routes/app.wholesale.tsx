import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest, type TFunc } from "../i18n";
import { hasFeature } from "../plan";
import { GATE_MODES, TIER_MODELS, type TierModel } from "../design-choices";
import { APPLICATION_FIELDS, countryName, type ApplicationPayload } from "../applications";
import type { TierEntry } from "../services/metafield.server";
import {
    applyTiersToAllProducts,
    collectTagOptions,
    createCustomerGroup,
    createMixMatchGroup,
    deleteCustomerGroup,
    deleteMixMatchGroup,
    getGateSettings,
    getTierSettings,
    listCustomerGroups,
    listMixMatchGroups,
    listMixMatchMembers,
    listTierProducts,
    listWholesalePrices,
    saveGateSettings,
    saveProductTiers,
    saveTierSettings,
    saveVariantWholesalePrices,
    setMixMatchMembers,
    updateCustomerGroup,
    updateMixMatchGroup,
} from "../services/wholesale.server";
import {
    approveWholesaleApplication,
    listWholesaleApplications,
    purgeExpiredRejectedApplications,
    rejectWholesaleApplication,
    saveWholesaleApplicationNote,
} from "../services/applications.server";
import { APPLY_PATH } from "../services/appProxy.server";
import {
    getProductRefsByIds,
    isTablelyError,
    listProductVariants,
    resolvePlan,
} from "../services/tables.server";

/**
 * Wholesale（M10）—— 批发门控 + 客户组管理 + 各子区空态
 *
 * 本页是 M10 的核心后台页，落三件事：
 *   ① **门控**（§1.4 #19，Pro）：模式 `off` / `hide_price` / `hide_table` + 合格客户标签；
 *      保存后写入 `ShopSettings` 并下发 `tablely.settings` 契约的 `gate`，
 *      店面 Liquid 下次渲染即按 `customer.tags` 实时判定（§五 / §2.4）。
 *   ② **客户组**（B11，Pro）：增删改名 + 映射 Shopify 客户标签；改标签时同一事务内
 *      迁移 `WholesalePrice.groupTag`，保证「改名后批发价仍生效」（§16.4 / M10 验收）。
 *   ③ **批发价 / 阶梯价 / Mix & Match**（M12，§6.1 / §16.2 / §16.4 / §16.5）：三块
 *      真实 CRUD —— 阶梯价的全局开关/模型 + 商品级档位 + 套用全部商品；批发价按
 *      「客户组标签 × 变体」逐项设价；混单组按「组 × 商品」勾选成员。每次写成功后
 *      服务层都会重下发 product metafield 并刷新 3 个 automatic discount 的 config。
 *
 * Pro 门控（M9 付费墙，§19.3）：门控与客户组属 Pro；Free 下**禁用编辑 + 显示 Pro 徽章 +
 * 升级链接**，后端 `saveGateSettings` / `createCustomerGroup` 等同步拒写（双保险）。
 * 申请子区属 Free（§1.6 D2：Free 可用默认表单 + 只读列表），故不加 Pro 锁。
 */

const valueOf = (event: Event): string =>
    String((event.currentTarget as unknown as { value?: string } | null)?.value ?? "");
const checkedOf = (event: Event): boolean =>
    Boolean((event.currentTarget as unknown as { checked?: boolean } | null)?.checked);

/** 空态主按钮 → 滚动到下方「新建客户组」表单（二者是同一动作，§6.1） */
function scrollToCreateGroup() {
    document
        .getElementById("wholesale-new-group")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 空态主按钮 → 滚动到下方「新建混单组」表单（同上，§16.5） */
function scrollToCreateMix() {
    document
        .getElementById("wholesale-new-mix")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Free 下显示的「Pro 功能」提示：徽章 + 升级链接（§19.3） */
function ProHint({ label, upgrade }: { label: string; upgrade: string }) {
    return (
        <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">{label}</s-badge>
            <s-link href="/app/plans">{upgrade}</s-link>
        </s-stack>
    );
}

/* ----------------------- M12：表单 ↔ 档位/批发价行 ----------------------- */

/** 从表单并行数组重建档位行（`qty` / `percent` / `price` 按索引对齐） */
function tiersFromForm(formData: FormData) {
    const qty = formData.getAll("qty").map((value) => String(value));
    const percent = formData.getAll("percent").map((value) => String(value));
    const price = formData.getAll("price").map((value) => String(value));
    const length = Math.max(qty.length, percent.length, price.length);
    return Array.from({ length }, (_, index) => ({
        qty: qty[index] ?? "",
        percent: percent[index] ?? "",
        price: price[index] ?? "",
    }));
}

/** 从表单并行数组重建批发价行（`variantId` / `price` 按索引对齐；空价 = 删除） */
function pricesFromForm(formData: FormData) {
    const variantId = formData.getAll("variantId").map((value) => String(value));
    const price = formData.getAll("price").map((value) => String(value));
    return variantId.map((id, index) => ({ variantId: id, price: price[index] ?? null }));
}

/** 档位行的可编辑形态（全程字符串，提交前由服务层校验） */
type TierRow = { qty: string; percent: string; price: string };

/** `TierEntry[]` → 可编辑行；空数组给一行空行，方便直接录入 */
function toTierRows(tiers: TierEntry[]): TierRow[] {
    if (tiers.length === 0) return [{ qty: "", percent: "", price: "" }];
    return tiers.map((tier) => ({
        qty: String(tier.qty),
        percent: tier.percent === undefined ? "" : String(tier.percent),
        price: tier.price ?? "",
    }));
}

/**
 * 档位行编辑器（受控）：字段名 `qty` + `percent`（模型 A）/ `price`（模型 B），
 * 外层 Form 提交后由 action 用 `tiersFromForm` 按索引复原为行数组。
 */
function TierEditor({
    t,
    model,
    rows,
    onChange,
    disabled,
    label,
}: {
    t: TFunc;
    model: TierModel;
    rows: TierRow[];
    onChange: (rows: TierRow[]) => void;
    disabled: boolean;
    label?: string;
}) {
    const update = (index: number, patch: Partial<TierRow>) =>
        onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

    return (
        <s-stack direction="block" gap="small">
            {label ? <s-text type="strong">{label}</s-text> : null}
            {rows.map((row, index) => (
                <s-stack key={index} direction="inline" gap="base" alignItems="end">
                    <s-text-field
                        name="qty"
                        label={t("wholesale.tierQty")}
                        value={row.qty}
                        disabled={disabled}
                        onChange={(event) => update(index, { qty: valueOf(event) })}
                    />
                    {model === "percent" ? (
                        <s-text-field
                            name="percent"
                            label={t("wholesale.tierPercent")}
                            value={row.percent}
                            disabled={disabled}
                            onChange={(event) => update(index, { percent: valueOf(event) })}
                        />
                    ) : (
                        <s-text-field
                            name="price"
                            label={t("wholesale.tierPrice")}
                            value={row.price}
                            disabled={disabled}
                            onChange={(event) => update(index, { price: valueOf(event) })}
                        />
                    )}
                    <s-button
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange(rows.filter((_, i) => i !== index))}
                    >
                        {t("wholesale.tierRemove")}
                    </s-button>
                </s-stack>
            ))}
            <s-stack direction="inline" gap="base">
                <s-button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange([...rows, { qty: "", percent: "", price: "" }])}
                >
                    {t("wholesale.tierAdd")}
                </s-button>
            </s-stack>
        </s-stack>
    );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const locale = localeFromRequest(request);
    const url = new URL(request.url);

    // 申请保留期清理（§8.1：被拒 90 天）：就近 best-effort，不引入独立调度器
    await purgeExpiredRejectedApplications(session.shop).catch((error) => {
        console.error("[tablely] 清理过期申请失败:", error);
    });

    const [plan, gate, groups, applications, tierSettings, tierProducts, mixGroups] =
        await Promise.all([
            resolvePlan(session.shop),
            getGateSettings(session.shop),
            listCustomerGroups(session.shop),
            listWholesaleApplications(session.shop),
            getTierSettings(session.shop),
            listTierProducts(session.shop),
            listMixMatchGroups(session.shop),
        ]);

    // M12：已配置订购表的商品 + 标题（一次批量取，避免逐个查询；取不到标题时退回 GID）
    const productRefs = await getProductRefsByIds(
        admin,
        tierProducts.map((row) => row.productId),
    ).catch((error) => {
        console.error("[tablely] 取商品标题失败:", error);
        return [];
    });
    const titleById = new Map(productRefs.map((ref) => [ref.id, ref.title]));
    const configuredProducts = tierProducts.map((row) => ({
        id: row.productId,
        title: titleById.get(row.productId) ?? row.productId,
        tiers: row.tiers,
    }));

    // 批发价（B5）：`WholesalePrice` 不存 productId，故变体集合来自 Admin，再按该集合过滤
    const priceProductId = url.searchParams.get("priceProductId");
    const priceVariants = priceProductId
        ? await listProductVariants(admin, priceProductId)
        : [];
    const wholesalePrices = await listWholesalePrices(
        session.shop,
        priceProductId ?? undefined,
        priceVariants.map((variant) => variant.id),
    );

    // Mix & Match（§16.5）：所选混单组的成员 + 所选商品的变体
    const mixGroupId = url.searchParams.get("mixGroupId");
    const mixProductId = url.searchParams.get("productId");
    const mixMembers = mixGroupId
        ? await listMixMatchMembers(session.shop, mixGroupId)
        : [];
    const mixVariants = mixProductId
        ? await listProductVariants(admin, mixProductId)
        : [];

    const toOption = (variant: { id: string; title: string; sku: string | null }) => ({
        id: variant.id,
        title: variant.title,
        sku: variant.sku,
    });

    return {
        locale,
        plan,
        gate,
        groups,
        applications: applications.map((application) => ({
            ...application,
            createdAt: application.createdAt.toISOString(),
        })),
        pendingCount: applications.filter((application) => application.status === "pending")
            .length,
        // 申请表单公开地址（§15.2）：用于空态「复制表单链接」与列表顶部展示
        formLink: `https://${session.shop}${APPLY_PATH}`,
        // 店铺 handle：审批通过后拼「打开该客户页」链接
        shopHandle: session.shop.replace(/\.myshopify\.com$/, ""),
        // 门控标签可选集：已保存标签 ∪ 现有客户组标签（避免手打标签拼错，B11）
        tagOptions: collectTagOptions(gate, groups),
        // M12：阶梯价 / 批发价 / 混单
        tierSettings,
        configuredProducts,
        tierProductId: url.searchParams.get("tierProductId"),
        priceProductId,
        priceVariants: priceVariants.map(toOption),
        wholesalePrices,
        mixGroups,
        mixGroupId,
        mixProductId,
        mixVariants: mixVariants.map(toOption),
        mixMembers,
    };
};

export const action = async ({ request }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "");

    try {
        if (intent === "save-gate") {
            await saveGateSettings({
                admin,
                shop: session.shop,
                mode: String(formData.get("mode") ?? "off"),
                tags: formData.getAll("tag").map((value) => String(value)),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        if (intent === "create-group") {
            await createCustomerGroup({
                shop: session.shop,
                name: formData.get("name"),
                tag: formData.get("tag"),
                note: formData.get("note"),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        if (intent === "update-group") {
            await updateCustomerGroup({
                shop: session.shop,
                id: String(formData.get("id") ?? ""),
                name: formData.get("name"),
                tag: formData.get("tag"),
                note: formData.get("note"),
            });
            return { ok: true as const, intent, toastKey: "toast.updated" };
        }

        if (intent === "delete-group") {
            const result = await deleteCustomerGroup({
                shop: session.shop,
                id: String(formData.get("id") ?? ""),
            });
            return {
                ok: true as const,
                intent,
                toastKey: "toast.deleted",
                deletedPrices: result.deletedPrices,
            };
        }

        if (intent === "approve-application") {
            const result = await approveWholesaleApplication({
                shop: session.shop,
                id: String(formData.get("id") ?? ""),
            });
            // 只回标签名；**不写客户 tag**（§15.2），由商家在客户页手动添加
            return { ok: true as const, intent, toastKey: "toast.saved", tag: result.tag };
        }

        if (intent === "reject-application") {
            await rejectWholesaleApplication({
                shop: session.shop,
                id: String(formData.get("id") ?? ""),
                note: formData.get("note"),
            });
            return { ok: true as const, intent, toastKey: "toast.updated" };
        }

        if (intent === "save-application-note") {
            await saveWholesaleApplicationNote({
                shop: session.shop,
                id: String(formData.get("id") ?? ""),
                note: formData.get("note"),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        /* ---------------- M12：阶梯价 / 批发价 / 混单 ---------------- */

        if (intent === "save-tier-settings") {
            await saveTierSettings({
                admin,
                shop: session.shop,
                enabled: formData.get("enabled"),
                model: formData.get("model"),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        if (intent === "save-product-tiers") {
            await saveProductTiers({
                admin,
                shop: session.shop,
                productId: String(formData.get("productId") ?? ""),
                tiers: tiersFromForm(formData),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        if (intent === "apply-tiers-all") {
            await applyTiersToAllProducts({
                admin,
                shop: session.shop,
                tiersRaw: tiersFromForm(formData),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        if (intent === "save-wholesale-prices") {
            await saveVariantWholesalePrices({
                admin,
                shop: session.shop,
                productId: String(formData.get("productId") ?? ""),
                groupTag: String(formData.get("groupTag") ?? ""),
                prices: pricesFromForm(formData),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        if (intent === "create-mix-group") {
            await createMixMatchGroup({
                admin,
                shop: session.shop,
                name: formData.get("name"),
                tiers: tiersFromForm(formData),
                model: formData.get("model"),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        if (intent === "update-mix-group") {
            await updateMixMatchGroup({
                admin,
                shop: session.shop,
                id: String(formData.get("id") ?? ""),
                name: formData.get("name"),
                tiers: tiersFromForm(formData),
                model: formData.get("model"),
            });
            return { ok: true as const, intent, toastKey: "toast.updated" };
        }

        if (intent === "delete-mix-group") {
            await deleteMixMatchGroup({
                admin,
                shop: session.shop,
                id: String(formData.get("id") ?? ""),
            });
            return { ok: true as const, intent, toastKey: "toast.deleted" };
        }

        if (intent === "save-mix-members") {
            await setMixMatchMembers({
                admin,
                shop: session.shop,
                groupId: String(formData.get("groupId") ?? ""),
                productId: String(formData.get("productId") ?? ""),
                variantIds: formData.getAll("variantId").map((value) => String(value)),
            });
            return { ok: true as const, intent, toastKey: "toast.saved" };
        }

        return { ok: false as const, intent, errorKey: "error.saveFailed" };
    } catch (error) {
        if (isTablelyError(error)) {
            return { ok: false as const, intent, errorKey: error.key, field: error.field ?? undefined };
        }
        console.error("[tablely] wholesale action failed:", error);
        return { ok: false as const, intent, errorKey: "error.saveFailed" };
    }
};

export default function WholesalePage() {
    const {
        locale,
        plan,
        gate,
        groups,
        tagOptions,
        applications,
        pendingCount,
        formLink,
        shopHandle,
        tierSettings,
        configuredProducts,
        tierProductId,
        priceProductId,
        priceVariants,
        wholesalePrices,
        mixGroups,
        mixGroupId,
        mixProductId,
        mixVariants,
        mixMembers,
    } = useLoaderData<typeof loader>();
    const t = getT(locale);
    const shopify = useAppBridge();

    const canGate = hasFeature(plan, "gating");
    const canGroups = hasFeature(plan, "customer_groups");
    const canApprove = hasFeature(plan, "approvals");
    const canTier = hasFeature(plan, "tier_pricing");
    const canPrice = hasFeature(plan, "wholesale_price");
    const canMix = hasFeature(plan, "mix_match");

    const gateFetcher = useFetcher<typeof action>();
    const groupFetcher = useFetcher<typeof action>();
    const applicationFetcher = useFetcher<typeof action>();
    const tierFetcher = useFetcher<typeof action>();
    const priceFetcher = useFetcher<typeof action>();
    const mixFetcher = useFetcher<typeof action>();

    // M12 三个子区共用 URL 参数切换「当前编辑对象」，避免为每个商品/组开一条路由
    const [searchParams, setSearchParams] = useSearchParams();
    const setParams = (patch: Record<string, string | null>) => {
        const next = new URLSearchParams(searchParams);
        for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === "") next.delete(key);
            else next.set(key, value);
        }
        setSearchParams(next);
    };

    const [mode, setMode] = useState<string>(gate.mode);
    const [tags, setTags] = useState<string[]>(gate.tags);
    const [createName, setCreateName] = useState("");
    const [createTag, setCreateTag] = useState("");
    const [createNote, setCreateNote] = useState("");
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState("");
    const [editTag, setEditTag] = useState("");
    const [editNote, setEditNote] = useState("");
    const [deleteId, setDeleteId] = useState<string | null>(null);
    // 申请审批（M11）：展开详情 / 拒绝原因 / 备注编辑 / 刚通过的申请（给复制标签引导）
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [rejectId, setRejectId] = useState<string | null>(null);
    const [rejectNote, setRejectNote] = useState("");
    const [noteId, setNoteId] = useState<string | null>(null);
    const [noteDraft, setNoteDraft] = useState("");
    const [approveId, setApproveId] = useState<string | null>(null);

    // M12：阶梯价（全局开关/模型 + 当前商品的档位行；行态全程字符串，提交后才校验）
    const [tierEnabled, setTierEnabled] = useState(tierSettings.enabled);
    const [tierModel, setTierModel] = useState<TierModel>(tierSettings.model);
    const [tierRows, setTierRows] = useState<TierRow[]>(() =>
        toTierRows(
            configuredProducts.find((product) => product.id === tierProductId)?.tiers ?? [],
        ),
    );
    // M12：批发价（客户组 + 各变体草稿，键为变体 GID；空串 = 删除该价）
    const [priceGroup, setPriceGroup] = useState(groups[0]?.tag ?? "");
    const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({});
    // M12：混单组（新建 / 编辑 / 删除 / 成员勾选）
    const [mixName, setMixName] = useState("");
    const [mixCreateRows, setMixCreateRows] = useState<TierRow[]>(() => toTierRows([]));
    const [editingMixId, setEditingMixId] = useState<string | null>(null);
    const [editMixName, setEditMixName] = useState("");
    const [editMixRows, setEditMixRows] = useState<TierRow[]>([]);
    const [deleteMixId, setDeleteMixId] = useState<string | null>(null);
    const [mixSelection, setMixSelection] = useState<string[]>([]);

    useEffect(() => {
        setMode(gate.mode);
        setTags(gate.tags);
    }, [gate]);

    const gateFailed = gateFetcher.data?.ok === false ? gateFetcher.data : null;
    const groupFailed = groupFetcher.data?.ok === false ? groupFetcher.data : null;
    const applicationFailed =
        applicationFetcher.data?.ok === false ? applicationFetcher.data : null;

    useEffect(() => {
        if (gateFetcher.data?.ok) shopify.toast.show(t(gateFetcher.data.toastKey));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gateFetcher.data]);

    useEffect(() => {
        const data = groupFetcher.data;
        if (!data?.ok) return;
        shopify.toast.show(t(data.toastKey));
        if (data.intent === "create-group") {
            setCreateName("");
            setCreateTag("");
            setCreateNote("");
        }
        if (data.intent === "update-group") setEditingId(null);
        if (data.intent === "delete-group") setDeleteId(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groupFetcher.data]);

    useEffect(() => {
        const data = applicationFetcher.data;
        if (!data?.ok) return;
        shopify.toast.show(t(data.toastKey));
        if (data.intent === "reject-application") {
            setRejectId(null);
            setRejectNote("");
        }
        if (data.intent === "save-application-note") setNoteId(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [applicationFetcher.data]);

    /* ----------------------- M12：loader 数据 ↔ 表单态同步 ----------------------- */

    const tierSelected = tierProductId
        ? configuredProducts.find((product) => product.id === tierProductId) ?? null
        : null;
    const tierSignature = tierSelected ? JSON.stringify(tierSelected.tiers) : "";
    useEffect(() => {
        setTierRows(toTierRows(tierSelected?.tiers ?? []));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tierProductId, tierSignature]);

    // 全局开关/模型以 loader（已保存值）为准：保存后 revalidate 会把 UI 拉回真实态
    useEffect(() => {
        setTierEnabled(tierSettings.enabled);
        setTierModel(tierSettings.model);
    }, [tierSettings.enabled, tierSettings.model]);

    // 选中的客户组一旦失效（被删或首屏无组）就回退到第一个可用组
    useEffect(() => {
        if (!groups.some((group) => group.tag === priceGroup)) {
            setPriceGroup(groups[0]?.tag ?? "");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [groups]);

    // 批发价草稿只保留「当前商品 × 当前客户组」的已存价，其余留空（提交空串 = 删除）
    const priceSignature = JSON.stringify(
        wholesalePrices.map((row) => [row.variantId, row.groupTag, row.price]),
    );
    useEffect(() => {
        const next: Record<string, string> = {};
        for (const row of wholesalePrices) {
            if (row.groupTag === priceGroup) next[row.variantId] = row.price;
        }
        setPriceDrafts(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [priceGroup, priceProductId, priceSignature]);

    // 成员勾选按「当前组 × 当前商品」回填（只保留仍在变体列表里的 id）
    const mixSignature = JSON.stringify(mixMembers);
    useEffect(() => {
        const selected = new Set(
            mixMembers
                .filter((member) => member.productId === mixProductId)
                .map((member) => member.variantId),
        );
        setMixSelection(
            mixVariants.filter((variant) => selected.has(variant.id)).map((variant) => variant.id),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mixGroupId, mixProductId, mixSignature]);

    const tierFailed = tierFetcher.data?.ok === false ? tierFetcher.data : null;
    const priceFailed = priceFetcher.data?.ok === false ? priceFetcher.data : null;
    const mixFailed = mixFetcher.data?.ok === false ? mixFetcher.data : null;

    useEffect(() => {
        if (tierFetcher.data?.ok) shopify.toast.show(t(tierFetcher.data.toastKey));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tierFetcher.data]);

    useEffect(() => {
        if (priceFetcher.data?.ok) shopify.toast.show(t(priceFetcher.data.toastKey));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [priceFetcher.data]);

    useEffect(() => {
        const data = mixFetcher.data;
        if (!data?.ok) return;
        shopify.toast.show(t(data.toastKey));
        if (data.intent === "create-mix-group") {
            setMixName("");
            setMixCreateRows(toTierRows([]));
        }
        if (data.intent === "update-mix-group") setEditingMixId(null);
        if (data.intent === "delete-mix-group") setDeleteMixId(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mixFetcher.data]);

    /** 变体显示名：`标题 · SKU`，两者都空时退回 GID（保证永远可辨认） */
    const variantLabel = (variant: { id: string; title: string; sku: string | null }) =>
        [variant.title, variant.sku].filter(Boolean).join(" · ") || variant.id;

    /** 档位/套用提交：受控行不依赖 DOM，手动组装并行数组（套用全部需复用同一份行态） */
    const submitTiers = (intentName: string, extra: Record<string, string>) => {
        const payload: Record<string, string | string[]> = {
            intent: intentName,
            ...extra,
            qty: tierRows.map((row) => row.qty),
        };
        if (tierSettings.model === "percent") {
            payload.percent = tierRows.map((row) => row.percent);
        } else {
            payload.price = tierRows.map((row) => row.price);
        }
        tierFetcher.submit(payload, { method: "post" });
    };

    const startEditMix = (group: (typeof mixGroups)[number]) => {
        setDeleteMixId(null);
        setEditingMixId(group.id);
        setEditMixName(group.name);
        setEditMixRows(toTierRows(group.tiers));
    };

    const toggleMixVariant = (variantId: string, checked: boolean) =>
        setMixSelection((prev) =>
            checked ? [...new Set([...prev, variantId])] : prev.filter((id) => id !== variantId),
        );

    /** 复制到剪贴板（空态 CTA「复制表单链接」/ 审批后「复制标签」「复制邮箱」） */
    const copyText = async (value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            shopify.toast.show(t("applications.copied"));
        } catch (error) {
            console.error("[tablely] 复制失败:", error);
        }
    };

    /** 申请详情：逐字段把 payload 渲染成人话（国家/选项走 i18n，脏值兜底为 —） */
    const detailRows = (payload: ApplicationPayload) => {
        const source = payload as unknown as Record<string, unknown>;
        return APPLICATION_FIELDS.filter((field) => field.key !== "privacyConsent").map(
            (field) => {
                const raw = source[field.key];
                let text: string;
                if (field.key === "country") {
                    text = raw ? countryName(String(raw), locale) : "—";
                } else if (field.key === "businessTypes" || field.key === "channels") {
                    const list = Array.isArray(raw) ? raw.map(String) : [];
                    text = list.length
                        ? list
                            .map((value) => t(`${field.optionKeyPrefix}.${value}`))
                            .join(", ")
                        : "—";
                } else if (
                    field.key === "brandExperience" ||
                    field.key === "monthlyVolume"
                ) {
                    text = raw ? t(`${field.optionKeyPrefix}.${raw}`) : "—";
                } else {
                    text = raw ? String(raw) : "—";
                }
                return { key: field.key, label: t(field.labelKey), text };
            },
        );
    };

    /** 审批通过后「打开该客户页」（仅当申请带了 logged_in_customer_id） */
    const customerUrl = (customerId: string) =>
        `https://admin.shopify.com/store/${shopHandle}/customers/${customerId}`;

    const statusTone = (status: string) =>
        status === "approved" ? "success" : status === "rejected" ? "critical" : "info";

    const approvedApp = approveId
        ? applications.find((application) => application.id === approveId) ?? null
        : null;
    const approvedTag =
        applicationFetcher.data?.ok &&
        applicationFetcher.data.intent === "approve-application"
            ? applicationFetcher.data.tag
            : null;

    const startEdit = (group: (typeof groups)[number]) => {
        setDeleteId(null);
        setEditingId(group.id);
        setEditName(group.name);
        setEditTag(group.tag);
        setEditNote(group.note ?? "");
    };

    const toggleTag = (tag: string, checked: boolean) =>
        setTags((prev) =>
            checked ? [...new Set([...prev, tag])] : prev.filter((item) => item !== tag),
        );

    return (
        <s-page heading={t("wholesale.title")}>
            {gateFailed ? (
                <s-banner tone="critical">{t(gateFailed.errorKey)}</s-banner>
            ) : null}
            {groupFailed ? (
                <s-banner tone="critical">{t(groupFailed.errorKey)}</s-banner>
            ) : null}
            {applicationFailed ? (
                <s-banner tone="critical">{t(applicationFailed.errorKey)}</s-banner>
            ) : null}
            {tierFailed ? (
                <s-banner tone="critical">{t(tierFailed.errorKey)}</s-banner>
            ) : null}
            {priceFailed ? (
                <s-banner tone="critical">{t(priceFailed.errorKey)}</s-banner>
            ) : null}
            {mixFailed ? (
                <s-banner tone="critical">{t(mixFailed.errorKey)}</s-banner>
            ) : null}

            {/* ① 门控（Pro）：模式 + 合格客户标签（§1.4 #19 / §五 gate） */}
            <s-section heading={t("wholesale.gate")}>
                <gateFetcher.Form method="post">
                    <input type="hidden" name="intent" value="save-gate" />
                    {tags.map((tag) => (
                        <input key={tag} type="hidden" name="tag" value={tag} />
                    ))}
                    <s-stack direction="block" gap="base">
                        <s-text color="subdued">{t("wholesale.gateHint")}</s-text>
                        {!canGate ? (
                            <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                        ) : null}

                        <s-select
                            name="mode"
                            label={t("wholesale.gateMode")}
                            value={mode}
                            disabled={!canGate}
                            onChange={(event) => setMode(valueOf(event))}
                        >
                            {GATE_MODES.map((option) => (
                                <s-option key={option} value={option}>
                                    {t(`wholesale.gateMode.${option}`)}
                                </s-option>
                            ))}
                        </s-select>

                        <s-text type="strong">{t("wholesale.gateTags")}</s-text>
                        <s-text color="subdued">{t("wholesale.gateTagsHint")}</s-text>
                        {tagOptions.length === 0 ? (
                            <s-text color="subdued">{t("wholesale.gateTagsEmpty")}</s-text>
                        ) : (
                            <s-stack direction="block" gap="small">
                                {tagOptions.map((tag) => (
                                    <s-checkbox
                                        key={tag}
                                        accessibilityLabel={tag}
                                        label={tag}
                                        checked={tags.includes(tag)}
                                        disabled={!canGate}
                                        onChange={(event) =>
                                            toggleTag(tag, checkedOf(event))
                                        }
                                    />
                                ))}
                            </s-stack>
                        )}

                        <s-stack direction="inline" gap="base">
                            <s-button
                                type="submit"
                                disabled={!canGate || gateFetcher.state !== "idle"}
                            >
                                {t("wholesale.gateSave")}
                            </s-button>
                        </s-stack>
                    </s-stack>
                </gateFetcher.Form>
            </s-section>

            {/* ② 客户组（Pro，B11）：增删改名 + 映射标签 */}
            <s-section heading={t("wholesale.groups")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("wholesale.groupsHint")}</s-text>
                    {!canGroups ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    {groups.length === 0 ? (
                        <s-empty-state heading={t("empty.groups.title")}>
                            <s-text slot="subheading">{t("empty.groups.body")}</s-text>
                            <s-button
                                slot="primary-action"
                                variant="primary"
                                disabled={!canGroups}
                                onClick={scrollToCreateGroup}
                            >
                                {t("empty.groups.cta")}
                            </s-button>
                        </s-empty-state>
                    ) : (
                        <s-stack direction="block" gap="base">
                            {groups.map((group) =>
                                editingId === group.id ? (
                                    <groupFetcher.Form key={group.id} method="post">
                                        <input type="hidden" name="intent" value="update-group" />
                                        <input type="hidden" name="id" value={group.id} />
                                        <s-box padding="base" border="base" borderRadius="base">
                                            <s-stack direction="block" gap="base">
                                                <s-text-field
                                                    name="name"
                                                    label={t("wholesale.groupName")}
                                                    value={editName}
                                                    disabled={!canGroups}
                                                    onChange={(event) =>
                                                        setEditName(valueOf(event))
                                                    }
                                                />
                                                <s-text-field
                                                    name="tag"
                                                    label={t("wholesale.groupTag")}
                                                    details={t("wholesale.groupTagHint")}
                                                    value={editTag}
                                                    disabled={!canGroups}
                                                    onChange={(event) =>
                                                        setEditTag(valueOf(event))
                                                    }
                                                />
                                                <s-text-field
                                                    name="note"
                                                    label={t("wholesale.groupNote")}
                                                    value={editNote}
                                                    disabled={!canGroups}
                                                    onChange={(event) =>
                                                        setEditNote(valueOf(event))
                                                    }
                                                />
                                                <s-stack direction="inline" gap="base">
                                                    <s-button
                                                        type="submit"
                                                        variant="primary"
                                                        disabled={
                                                            !canGroups ||
                                                            groupFetcher.state !== "idle"
                                                        }
                                                    >
                                                        {t("wholesale.groupSave")}
                                                    </s-button>
                                                    <s-button
                                                        type="button"
                                                        onClick={() => setEditingId(null)}
                                                    >
                                                        {t("wholesale.groupCancel")}
                                                    </s-button>
                                                </s-stack>
                                            </s-stack>
                                        </s-box>
                                    </groupFetcher.Form>
                                ) : (
                                    <s-box
                                        key={group.id}
                                        padding="base"
                                        border="base"
                                        borderRadius="base"
                                    >
                                        <s-stack direction="block" gap="small">
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
                                                    <s-text type="strong">{group.name}</s-text>
                                                    <s-badge tone="info">{group.tag}</s-badge>
                                                </s-stack>
                                                <s-stack direction="inline" gap="base">
                                                    <s-button
                                                        disabled={!canGroups}
                                                        onClick={() => startEdit(group)}
                                                    >
                                                        {t("wholesale.groupEdit")}
                                                    </s-button>
                                                    <s-button
                                                        variant="tertiary"
                                                        tone="critical"
                                                        disabled={!canGroups}
                                                        onClick={() => setDeleteId(group.id)}
                                                    >
                                                        {t("wholesale.groupDelete")}
                                                    </s-button>
                                                </s-stack>
                                            </s-stack>
                                            {group.note ? (
                                                <s-text color="subdued">{group.note}</s-text>
                                            ) : null}
                                            <s-text color="subdued">
                                                {group.priceCount > 0
                                                    ? t("wholesale.groupPrices", {
                                                        n: group.priceCount,
                                                    })
                                                    : t("wholesale.groupPricesNone")}
                                            </s-text>

                                            {deleteId === group.id ? (
                                                <s-banner tone="warning">
                                                    <s-stack direction="block" gap="base">
                                                        <s-text>
                                                            {t("wholesale.groupDeleteWarning", {
                                                                n: group.priceCount,
                                                            })}
                                                        </s-text>
                                                        <s-stack direction="inline" gap="base">
                                                            <s-button
                                                                type="button"
                                                                variant="primary"
                                                                tone="critical"
                                                                disabled={
                                                                    groupFetcher.state !== "idle"
                                                                }
                                                                onClick={() =>
                                                                    groupFetcher.submit(
                                                                        {
                                                                            intent: "delete-group",
                                                                            id: group.id,
                                                                        },
                                                                        { method: "post" },
                                                                    )
                                                                }
                                                            >
                                                                {t("wholesale.groupDeleteConfirm")}
                                                            </s-button>
                                                            <s-button
                                                                type="button"
                                                                onClick={() => setDeleteId(null)}
                                                            >
                                                                {t("wholesale.groupCancel")}
                                                            </s-button>
                                                        </s-stack>
                                                    </s-stack>
                                                </s-banner>
                                            ) : null}
                                        </s-stack>
                                    </s-box>
                                ),
                            )}
                        </s-stack>
                    )}

                    {/* 新建客户组：与空态主按钮是同一动作（§6.1） */}
                    <div id="wholesale-new-group">
                        <groupFetcher.Form method="post">
                            <input type="hidden" name="intent" value="create-group" />
                            <s-box padding="base" border="base" borderRadius="base">
                                <s-stack direction="block" gap="base">
                                    <s-text type="strong">{t("wholesale.groupCreate")}</s-text>
                                    <s-text-field
                                        name="name"
                                        label={t("wholesale.groupName")}
                                        value={createName}
                                        disabled={!canGroups}
                                        onChange={(event) => setCreateName(valueOf(event))}
                                    />
                                    <s-text-field
                                        name="tag"
                                        label={t("wholesale.groupTag")}
                                        details={t("wholesale.groupTagHint")}
                                        value={createTag}
                                        disabled={!canGroups}
                                        onChange={(event) => setCreateTag(valueOf(event))}
                                    />
                                    <s-text-field
                                        name="note"
                                        label={t("wholesale.groupNote")}
                                        value={createNote}
                                        disabled={!canGroups}
                                        onChange={(event) => setCreateNote(valueOf(event))}
                                    />
                                    <s-stack direction="inline" gap="base">
                                        <s-button
                                            type="submit"
                                            variant="primary"
                                            disabled={!canGroups || groupFetcher.state !== "idle"}
                                        >
                                            {t("wholesale.groupCreate")}
                                        </s-button>
                                    </s-stack>
                                </s-stack>
                            </s-box>
                        </groupFetcher.Form>
                    </div>
                </s-stack>
            </s-section>

            {/* ③ 批发价（Pro，B5，M12）：按「客户组标签 × 变体」逐项设价（§16.4） */}
            <s-section heading={t("wholesale.prices")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("wholesale.pricesHint")}</s-text>
                    {!canPrice ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    {groups.length === 0 ? (
                        <s-text color="subdued">{t("wholesale.priceNoGroups")}</s-text>
                    ) : configuredProducts.length === 0 ? (
                        <s-text color="subdued">{t("wholesale.priceNoProducts")}</s-text>
                    ) : (
                        <priceFetcher.Form method="post">
                            <input type="hidden" name="intent" value="save-wholesale-prices" />
                            <input type="hidden" name="productId" value={priceProductId ?? ""} />
                            <input type="hidden" name="groupTag" value={priceGroup} />
                            <s-stack direction="block" gap="base">
                                <s-select
                                    label={t("wholesale.priceProduct")}
                                    value={priceProductId ?? ""}
                                    disabled={!canPrice}
                                    onChange={(event) =>
                                        setParams({ priceProductId: valueOf(event) || null })
                                    }
                                >
                                    <s-option value="">{t("wholesale.pricePickProduct")}</s-option>
                                    {configuredProducts.map((product) => (
                                        <s-option key={product.id} value={product.id}>
                                            {product.title}
                                        </s-option>
                                    ))}
                                </s-select>

                                <s-select
                                    label={t("wholesale.priceGroup")}
                                    value={priceGroup}
                                    disabled={!canPrice}
                                    onChange={(event) => setPriceGroup(valueOf(event))}
                                >
                                    {groups.map((group) => (
                                        <s-option key={group.id} value={group.tag}>
                                            {`${group.name} · ${group.tag}`}
                                        </s-option>
                                    ))}
                                </s-select>

                                {priceProductId ? (
                                    <>
                                        <s-text color="subdued">{t("wholesale.priceHint")}</s-text>
                                        {priceVariants.map((variant) => (
                                            <s-stack
                                                key={variant.id}
                                                direction="inline"
                                                gap="base"
                                                alignItems="end"
                                            >
                                                <input
                                                    type="hidden"
                                                    name="variantId"
                                                    value={variant.id}
                                                />
                                                <s-text>{variantLabel(variant)}</s-text>
                                                <s-text-field
                                                    name="price"
                                                    label={t("wholesale.priceAmount")}
                                                    value={priceDrafts[variant.id] ?? ""}
                                                    disabled={!canPrice}
                                                    onChange={(event) =>
                                                        setPriceDrafts((prev) => ({
                                                            ...prev,
                                                            [variant.id]: valueOf(event),
                                                        }))
                                                    }
                                                />
                                            </s-stack>
                                        ))}
                                        <s-stack direction="inline" gap="base">
                                            <s-button
                                                type="submit"
                                                variant="primary"
                                                disabled={!canPrice || priceFetcher.state !== "idle"}
                                            >
                                                {t("wholesale.priceSave")}
                                            </s-button>
                                        </s-stack>
                                    </>
                                ) : (
                                    <s-empty-state heading={t("empty.prices.title")}>
                                        <s-text slot="subheading">{t("empty.prices.body")}</s-text>
                                    </s-empty-state>
                                )}
                            </s-stack>
                        </priceFetcher.Form>
                    )}
                </s-stack>
            </s-section>

            {/* ④ 阶梯价（Pro，M12）：全局开关/模型 + 商品级档位 + 套用全部商品（§16.2） */}
            <s-section heading={t("wholesale.tiers")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("wholesale.tiersHint")}</s-text>
                    {!canTier ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    <s-box padding="base" border="base" borderRadius="base">
                        <tierFetcher.Form method="post">
                            <input type="hidden" name="intent" value="save-tier-settings" />
                            <s-stack direction="block" gap="base">
                                <s-text type="strong">{t("wholesale.tierSettings")}</s-text>
                                <s-switch
                                    name="enabled"
                                    label={t("wholesale.tierEnabled")}
                                    checked={tierEnabled}
                                    disabled={!canTier}
                                    onChange={(event) => setTierEnabled(checkedOf(event))}
                                />
                                <s-text color="subdued">{t("wholesale.tierEnabledHint")}</s-text>
                                <s-select
                                    name="model"
                                    label={t("wholesale.tierModel")}
                                    value={tierModel}
                                    disabled={!canTier}
                                    onChange={(event) => setTierModel(valueOf(event) as TierModel)}
                                >
                                    {TIER_MODELS.map((option) => (
                                        <s-option key={option} value={option}>
                                            {t(`wholesale.tierModel.${option}`)}
                                        </s-option>
                                    ))}
                                </s-select>
                                <s-stack direction="inline" gap="base">
                                    <s-button
                                        type="submit"
                                        disabled={!canTier || tierFetcher.state !== "idle"}
                                    >
                                        {t("wholesale.tierSettingsSave")}
                                    </s-button>
                                </s-stack>
                            </s-stack>
                        </tierFetcher.Form>
                    </s-box>

                    {configuredProducts.length === 0 ? (
                        <s-text color="subdued">{t("wholesale.tierNoProducts")}</s-text>
                    ) : (
                        <tierFetcher.Form method="post">
                            <input type="hidden" name="intent" value="save-product-tiers" />
                            <input type="hidden" name="productId" value={tierProductId ?? ""} />
                            <s-stack direction="block" gap="base">
                                <s-select
                                    label={t("wholesale.tierProduct")}
                                    value={tierProductId ?? ""}
                                    disabled={!canTier}
                                    onChange={(event) =>
                                        setParams({ tierProductId: valueOf(event) || null })
                                    }
                                >
                                    <s-option value="">{t("wholesale.tierPickProduct")}</s-option>
                                    {configuredProducts.map((product) => (
                                        <s-option key={product.id} value={product.id}>
                                            {product.title}
                                        </s-option>
                                    ))}
                                </s-select>

                                {tierSelected ? (
                                    <>
                                        <TierEditor
                                            t={t}
                                            model={tierSettings.model}
                                            rows={tierRows}
                                            onChange={setTierRows}
                                            disabled={!canTier}
                                        />
                                        <s-stack direction="inline" gap="base">
                                            <s-button
                                                type="submit"
                                                variant="primary"
                                                disabled={!canTier || tierFetcher.state !== "idle"}
                                            >
                                                {t("wholesale.tierSave")}
                                            </s-button>
                                            <s-button
                                                type="button"
                                                disabled={!canTier || tierFetcher.state !== "idle"}
                                                onClick={() => submitTiers("apply-tiers-all", {})}
                                            >
                                                {t("wholesale.tierApplyAll")}
                                            </s-button>
                                        </s-stack>
                                    </>
                                ) : null}
                            </s-stack>
                        </tierFetcher.Form>
                    )}
                </s-stack>
            </s-section>

            {/* ⑤ Mix & Match 混单组（Pro，Y13，M12）：组 CRUD + 成员勾选（§16.5） */}
            <s-section heading={t("wholesale.mixmatch")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("wholesale.mixHint")}</s-text>
                    {!canMix ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}

                    {mixGroups.length === 0 ? (
                        <s-empty-state heading={t("empty.mixmatch.title")}>
                            <s-text slot="subheading">{t("empty.mixmatch.body")}</s-text>
                            <s-button
                                slot="primary-action"
                                variant="primary"
                                disabled={!canMix}
                                onClick={scrollToCreateMix}
                            >
                                {t("empty.mixmatch.cta")}
                            </s-button>
                        </s-empty-state>
                    ) : (
                        <s-stack direction="block" gap="base">
                            {mixGroups.map((group) =>
                                editingMixId === group.id ? (
                                    <mixFetcher.Form key={group.id} method="post">
                                        <input
                                            type="hidden"
                                            name="intent"
                                            value="update-mix-group"
                                        />
                                        <input type="hidden" name="id" value={group.id} />
                                        <input
                                            type="hidden"
                                            name="model"
                                            value={tierSettings.model}
                                        />
                                        <s-box padding="base" border="base" borderRadius="base">
                                            <s-stack direction="block" gap="base">
                                                <s-text-field
                                                    name="name"
                                                    label={t("wholesale.mixName")}
                                                    value={editMixName}
                                                    disabled={!canMix}
                                                    onChange={(event) =>
                                                        setEditMixName(valueOf(event))
                                                    }
                                                />
                                                <TierEditor
                                                    t={t}
                                                    model={tierSettings.model}
                                                    rows={editMixRows}
                                                    onChange={setEditMixRows}
                                                    disabled={!canMix}
                                                    label={t("wholesale.mixTiers")}
                                                />
                                                <s-stack direction="inline" gap="base">
                                                    <s-button
                                                        type="submit"
                                                        variant="primary"
                                                        disabled={
                                                            !canMix || mixFetcher.state !== "idle"
                                                        }
                                                    >
                                                        {t("wholesale.mixSave")}
                                                    </s-button>
                                                    <s-button
                                                        type="button"
                                                        onClick={() => setEditingMixId(null)}
                                                    >
                                                        {t("wholesale.groupCancel")}
                                                    </s-button>
                                                </s-stack>
                                            </s-stack>
                                        </s-box>
                                    </mixFetcher.Form>
                                ) : (
                                    <s-box
                                        key={group.id}
                                        padding="base"
                                        border="base"
                                        borderRadius="base"
                                    >
                                        <s-stack direction="block" gap="small">
                                            <s-stack
                                                direction="inline"
                                                gap="base"
                                                alignItems="center"
                                                justifyContent="space-between"
                                            >
                                                <s-text type="strong">{group.name}</s-text>
                                                <s-stack direction="inline" gap="base">
                                                    <s-button
                                                        disabled={!canMix}
                                                        onClick={() => startEditMix(group)}
                                                    >
                                                        {t("wholesale.mixEdit")}
                                                    </s-button>
                                                    <s-button
                                                        variant="tertiary"
                                                        tone="critical"
                                                        disabled={!canMix}
                                                        onClick={() => setDeleteMixId(group.id)}
                                                    >
                                                        {t("wholesale.mixDelete")}
                                                    </s-button>
                                                </s-stack>
                                            </s-stack>
                                            <s-text color="subdued">
                                                {[
                                                    group.tiers.length > 0
                                                        ? t("wholesale.mixTiersCount", {
                                                            n: group.tiers.length,
                                                        })
                                                        : null,
                                                    t("wholesale.mixMembersCount", {
                                                        n: group.memberCount,
                                                    }),
                                                ]
                                                    .filter(Boolean)
                                                    .join(" · ")}
                                            </s-text>

                                            {deleteMixId === group.id ? (
                                                <s-banner tone="warning">
                                                    <s-stack direction="block" gap="base">
                                                        <s-text>
                                                            {t("wholesale.mixDeleteWarning", {
                                                                n: group.memberCount,
                                                            })}
                                                        </s-text>
                                                        <s-stack direction="inline" gap="base">
                                                            <s-button
                                                                type="button"
                                                                variant="primary"
                                                                tone="critical"
                                                                disabled={mixFetcher.state !== "idle"}
                                                                onClick={() =>
                                                                    mixFetcher.submit(
                                                                        {
                                                                            intent: "delete-mix-group",
                                                                            id: group.id,
                                                                        },
                                                                        { method: "post" },
                                                                    )
                                                                }
                                                            >
                                                                {t("wholesale.mixDeleteConfirm")}
                                                            </s-button>
                                                            <s-button
                                                                type="button"
                                                                onClick={() => setDeleteMixId(null)}
                                                            >
                                                                {t("wholesale.groupCancel")}
                                                            </s-button>
                                                        </s-stack>
                                                    </s-stack>
                                                </s-banner>
                                            ) : null}
                                        </s-stack>
                                    </s-box>
                                ),
                            )}
                        </s-stack>
                    )}

                    {/* 新建混单组：空态主按钮与这里是同一动作（滚动定位，§16.5） */}
                    <div id="wholesale-new-mix">
                        <mixFetcher.Form method="post">
                            <input type="hidden" name="intent" value="create-mix-group" />
                            <input type="hidden" name="model" value={tierSettings.model} />
                            <s-box padding="base" border="base" borderRadius="base">
                                <s-stack direction="block" gap="base">
                                    <s-text type="strong">{t("wholesale.mixCreate")}</s-text>
                                    <s-text-field
                                        name="name"
                                        label={t("wholesale.mixName")}
                                        value={mixName}
                                        disabled={!canMix}
                                        onChange={(event) => setMixName(valueOf(event))}
                                    />
                                    <TierEditor
                                        t={t}
                                        model={tierSettings.model}
                                        rows={mixCreateRows}
                                        onChange={setMixCreateRows}
                                        disabled={!canMix}
                                        label={t("wholesale.mixTiers")}
                                    />
                                    <s-stack direction="inline" gap="base">
                                        <s-button
                                            type="submit"
                                            variant="primary"
                                            disabled={!canMix || mixFetcher.state !== "idle"}
                                        >
                                            {t("wholesale.mixCreate")}
                                        </s-button>
                                    </s-stack>
                                </s-stack>
                            </s-box>
                        </mixFetcher.Form>
                    </div>

                    {/* 成员勾选（组 × 商品）：只统计显式加入组的变体（§16.5） */}
                    {mixGroups.length === 0 ? null : (
                        <mixFetcher.Form method="post">
                            <input type="hidden" name="intent" value="save-mix-members" />
                            <input type="hidden" name="groupId" value={mixGroupId ?? ""} />
                            <input type="hidden" name="productId" value={mixProductId ?? ""} />
                            <s-box padding="base" border="base" borderRadius="base">
                                <s-stack direction="block" gap="base">
                                    <s-text type="strong">{t("wholesale.mixMembers")}</s-text>
                                    <s-select
                                        label={t("wholesale.mixGroup")}
                                        value={mixGroupId ?? ""}
                                        disabled={!canMix}
                                        onChange={(event) =>
                                            setParams({
                                                mixGroupId: valueOf(event) || null,
                                                productId: null,
                                            })
                                        }
                                    >
                                        <s-option value="">{t("wholesale.mixPickGroup")}</s-option>
                                        {mixGroups.map((group) => (
                                            <s-option key={group.id} value={group.id}>
                                                {group.name}
                                            </s-option>
                                        ))}
                                    </s-select>
                                    <s-select
                                        label={t("wholesale.mixProduct")}
                                        value={mixProductId ?? ""}
                                        disabled={!canMix}
                                        onChange={(event) =>
                                            setParams({ productId: valueOf(event) || null })
                                        }
                                    >
                                        <s-option value="">{t("wholesale.mixPickProduct")}</s-option>
                                        {configuredProducts.map((product) => (
                                            <s-option key={product.id} value={product.id}>
                                                {product.title}
                                            </s-option>
                                        ))}
                                    </s-select>

                                    {mixGroupId && mixProductId ? (
                                        <>
                                            <s-text color="subdued">
                                                {t("wholesale.mixPriority")}
                                            </s-text>
                                            {mixVariants.map((variant) => (
                                                <s-stack
                                                    key={variant.id}
                                                    direction="inline"
                                                    gap="base"
                                                    alignItems="center"
                                                >
                                                    {mixSelection.includes(variant.id) ? (
                                                        <input
                                                            type="hidden"
                                                            name="variantId"
                                                            value={variant.id}
                                                        />
                                                    ) : null}
                                                    <s-checkbox
                                                        accessibilityLabel={variantLabel(variant)}
                                                        label={variantLabel(variant)}
                                                        checked={mixSelection.includes(variant.id)}
                                                        disabled={!canMix}
                                                        onChange={(event) =>
                                                            toggleMixVariant(
                                                                variant.id,
                                                                checkedOf(event),
                                                            )
                                                        }
                                                    />
                                                </s-stack>
                                            ))}
                                            <s-stack direction="inline" gap="base">
                                                <s-button
                                                    type="submit"
                                                    variant="primary"
                                                    disabled={!canMix || mixFetcher.state !== "idle"}
                                                >
                                                    {t("wholesale.mixSaveMembers")}
                                                </s-button>
                                            </s-stack>
                                        </>
                                    ) : null}
                                </s-stack>
                            </s-box>
                        </mixFetcher.Form>
                    )}
                </s-stack>
            </s-section>

            {/* ⑥ 申请（Free 可提交/只读，Pro 可审批，M11 / §15.2）：列表 + 审批流 */}
            <s-section heading={t("wholesale.applications")}>
                <s-stack direction="block" gap="base">
                    <s-text color="subdued">{t("wholesale.applicationsHint")}</s-text>
                    {!canApprove ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}
                    {pendingCount > 0 ? (
                        <s-text type="strong">
                            {t("applications.pendingCount", { n: pendingCount })}
                        </s-text>
                    ) : null}

                    {/* 表单公开地址：空态与列表都需要可复制（§6.1 / §15.2） */}
                    <s-box padding="base" border="base" borderRadius="base">
                        <s-stack
                            direction="inline"
                            gap="base"
                            alignItems="center"
                            justifyContent="space-between"
                        >
                            <s-text color="subdued">{formLink}</s-text>
                            <s-button onClick={() => copyText(formLink)}>
                                {t("applications.copyLink")}
                            </s-button>
                        </s-stack>
                    </s-box>

                    {applications.length === 0 ? (
                        <s-empty-state heading={t("empty.applications.title")}>
                            <s-text slot="subheading">{t("empty.applications.body")}</s-text>
                            <s-button
                                slot="primary-action"
                                variant="primary"
                                onClick={() => copyText(formLink)}
                            >
                                {t("empty.applications.cta")}
                            </s-button>
                        </s-empty-state>
                    ) : (
                        <s-stack direction="block" gap="base">
                            {applications.map((application) => (
                                <s-box
                                    key={application.id}
                                    padding="base"
                                    border="base"
                                    borderRadius="base"
                                >
                                    <s-stack direction="block" gap="small">
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
                                                <s-text type="strong">
                                                    {`${application.payload.firstName} ${application.payload.lastName}`.trim() ||
                                                        application.payload.email}
                                                </s-text>
                                                <s-badge tone={statusTone(application.status)}>
                                                    {t(`applications.status.${application.status}`)}
                                                </s-badge>
                                            </s-stack>
                                            <s-text color="subdued">
                                                {new Date(
                                                    application.createdAt,
                                                ).toLocaleDateString(locale, {
                                                    year: "numeric",
                                                    month: "short",
                                                    day: "numeric",
                                                })}
                                            </s-text>
                                        </s-stack>
                                        <s-text color="subdued">
                                            {[
                                                application.payload.company,
                                                application.payload.email,
                                                countryName(application.payload.country, locale),
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </s-text>

                                        <s-stack direction="inline" gap="base">
                                            <s-button
                                                onClick={() =>
                                                    setExpandedId(
                                                        expandedId === application.id
                                                            ? null
                                                            : application.id,
                                                    )
                                                }
                                            >
                                                {expandedId === application.id
                                                    ? t("applications.hideDetails")
                                                    : t("applications.showDetails")}
                                            </s-button>
                                            {canApprove ? (
                                                <>
                                                    {application.status === "pending" ? (
                                                        <>
                                                            <s-button
                                                                variant="primary"
                                                                disabled={
                                                                    applicationFetcher.state !==
                                                                    "idle"
                                                                }
                                                                onClick={() => {
                                                                    setRejectId(null);
                                                                    setApproveId(application.id);
                                                                    applicationFetcher.submit(
                                                                        {
                                                                            intent: "approve-application",
                                                                            id: application.id,
                                                                        },
                                                                        { method: "post" },
                                                                    );
                                                                }}
                                                            >
                                                                {t("applications.approve")}
                                                            </s-button>
                                                            <s-button
                                                                tone="critical"
                                                                disabled={
                                                                    applicationFetcher.state !==
                                                                    "idle"
                                                                }
                                                                onClick={() => {
                                                                    setNoteId(null);
                                                                    setRejectId(application.id);
                                                                    setRejectNote("");
                                                                }}
                                                            >
                                                                {t("applications.reject")}
                                                            </s-button>
                                                        </>
                                                    ) : null}
                                                    <s-button
                                                        onClick={() => {
                                                            setRejectId(null);
                                                            setNoteId(application.id);
                                                            setNoteDraft(
                                                                application.note ?? "",
                                                            );
                                                        }}
                                                    >
                                                        {t("applications.note")}
                                                    </s-button>
                                                </>
                                            ) : null}
                                        </s-stack>

                                        {expandedId === application.id ? (
                                            <s-box
                                                padding="small"
                                                border="base"
                                                borderRadius="base"
                                            >
                                                <s-stack direction="block" gap="small">
                                                    {detailRows(application.payload).map((row) => (
                                                        <s-stack
                                                            key={row.key}
                                                            direction="inline"
                                                            gap="base"
                                                            alignItems="center"
                                                        >
                                                            <s-text color="subdued">
                                                                {row.label}
                                                            </s-text>
                                                            <s-text>{row.text}</s-text>
                                                        </s-stack>
                                                    ))}
                                                    {application.note ? (
                                                        <s-text color="subdued">
                                                            {t("applications.savedNote", {
                                                                note: application.note,
                                                            })}
                                                        </s-text>
                                                    ) : null}
                                                </s-stack>
                                            </s-box>
                                        ) : null}

                                        {rejectId === application.id ? (
                                            <s-banner tone="warning">
                                                <s-stack direction="block" gap="base">
                                                    <s-text-field
                                                        label={t("applications.rejectReason")}
                                                        value={rejectNote}
                                                        onChange={(event) =>
                                                            setRejectNote(valueOf(event))
                                                        }
                                                    />
                                                    <s-stack direction="inline" gap="base">
                                                        <s-button
                                                            variant="primary"
                                                            tone="critical"
                                                            disabled={
                                                                applicationFetcher.state !==
                                                                "idle"
                                                            }
                                                            onClick={() =>
                                                                applicationFetcher.submit(
                                                                    {
                                                                        intent: "reject-application",
                                                                        id: application.id,
                                                                        note: rejectNote,
                                                                    },
                                                                    { method: "post" },
                                                                )
                                                            }
                                                        >
                                                            {t("applications.rejectConfirm")}
                                                        </s-button>
                                                        <s-button
                                                            onClick={() => setRejectId(null)}
                                                        >
                                                            {t("applications.cancel")}
                                                        </s-button>
                                                    </s-stack>
                                                </s-stack>
                                            </s-banner>
                                        ) : null}

                                        {noteId === application.id ? (
                                            <s-stack direction="block" gap="base">
                                                <s-text-field
                                                    label={t("applications.note")}
                                                    value={noteDraft}
                                                    onChange={(event) =>
                                                        setNoteDraft(valueOf(event))
                                                    }
                                                />
                                                <s-stack direction="inline" gap="base">
                                                    <s-button
                                                        variant="primary"
                                                        disabled={
                                                            applicationFetcher.state !== "idle"
                                                        }
                                                        onClick={() =>
                                                            applicationFetcher.submit(
                                                                {
                                                                    intent: "save-application-note",
                                                                    id: application.id,
                                                                    note: noteDraft,
                                                                },
                                                                { method: "post" },
                                                            )
                                                        }
                                                    >
                                                        {t("applications.saveNote")}
                                                    </s-button>
                                                    <s-button onClick={() => setNoteId(null)}>
                                                        {t("applications.cancel")}
                                                    </s-button>
                                                </s-stack>
                                            </s-stack>
                                        ) : null}
                                    </s-stack>
                                </s-box>
                            ))}
                        </s-stack>
                    )}

                    {/* 审批通过后的「手动打标签」引导（§15.2 关键取舍：应用不写客户 tag） */}
                    {approvedApp ? (
                        <s-banner tone="success">
                            <s-stack direction="block" gap="base">
                                <s-text>{t("applications.approveNext")}</s-text>
                                <s-stack direction="inline" gap="base" alignItems="center">
                                    <s-badge tone="info">
                                        {approvedTag ?? "tablely-wholesale"}
                                    </s-badge>
                                    <s-button
                                        onClick={() =>
                                            copyText(approvedTag ?? "tablely-wholesale")
                                        }
                                    >
                                        {t("applications.copyTag")}
                                    </s-button>
                                    {approvedApp.customerId ? (
                                        <s-link
                                            href={customerUrl(approvedApp.customerId)}
                                            target="_blank"
                                        >
                                            {t("applications.openCustomer")}
                                        </s-link>
                                    ) : (
                                        <s-button
                                            onClick={() =>
                                                copyText(approvedApp.payload.email)
                                            }
                                        >
                                            {t("applications.copyEmail")}
                                        </s-button>
                                    )}
                                </s-stack>
                                <s-text color="subdued">
                                    {t("applications.noAutoWrite")}
                                </s-text>
                            </s-stack>
                        </s-banner>
                    ) : null}
                </s-stack>
            </s-section>
        </s-page>
    );
}