import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { hasFeature } from "../plan";
import { GATE_MODES } from "../design-choices";
import {
    collectTagOptions,
    createCustomerGroup,
    deleteCustomerGroup,
    getGateSettings,
    listCustomerGroups,
    saveGateSettings,
    updateCustomerGroup,
} from "../services/wholesale.server";
import { isTablelyError, resolvePlan } from "../services/tables.server";

/**
 * Wholesale（M10）—— 批发门控 + 客户组管理 + 各子区空态
 *
 * 本页是 M10 的核心后台页，落三件事：
 *   ① **门控**（§1.4 #19，Pro）：模式 `off` / `hide_price` / `hide_table` + 合格客户标签；
 *      保存后写入 `ShopSettings` 并下发 `tablely.settings` 契约的 `gate`，
 *      店面 Liquid 下次渲染即按 `customer.tags` 实时判定（§五 / §2.4）。
 *   ② **客户组**（B11，Pro）：增删改名 + 映射 Shopify 客户标签；改标签时同一事务内
 *      迁移 `WholesalePrice.groupTag`，保证「改名后批发价仍生效」（§16.4 / M10 验收）。
 *   ③ **各子区空态**（Y12 / §6.1）：批发价 / 阶梯价 / 混单组 / 申请 —— 对应能力在
 *      M11（申请）与 M12（价 / 档位 / 混单）落地，本里程碑先把**空态入口**建对：
 *      标题 + 说明 + 主按钮，且**不出现裸文案「暂无数据」**。
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

/** Free 下显示的「Pro 功能」提示：徽章 + 升级链接（§19.3） */
function ProHint({ label, upgrade }: { label: string; upgrade: string }) {
    return (
        <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">{label}</s-badge>
            <s-link href="/app/plans">{upgrade}</s-link>
        </s-stack>
    );
}

/**
 * 未落地能力的占位空态（§6.1 各子区）：标题 + 说明 + 主按钮**结构齐全**，
 * 按钮暂置灰并附「后续步骤提供」说明 —— 避免跳到尚未存在的功能。
 */
function PlannedEmptyState({
    heading,
    body,
    cta,
    secondary,
    hint,
}: {
    heading: string;
    body?: string;
    cta: string;
    secondary?: string;
    hint: string;
}) {
    return (
        <s-stack direction="block" gap="small">
            <s-empty-state heading={heading}>
                {body ? <s-text slot="subheading">{body}</s-text> : null}
                <s-button slot="primary-action" variant="primary" disabled>
                    {cta}
                </s-button>
                {secondary ? (
                    <s-button slot="secondary-actions" variant="secondary" disabled>
                        {secondary}
                    </s-button>
                ) : null}
            </s-empty-state>
            <s-text color="subdued">{hint}</s-text>
        </s-stack>
    );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { session } = await authenticate.admin(request);
    const locale = localeFromRequest(request);

    const [plan, gate, groups] = await Promise.all([
        resolvePlan(session.shop),
        getGateSettings(session.shop),
        listCustomerGroups(session.shop),
    ]);

    return {
        locale,
        plan,
        gate,
        groups,
        // 门控标签可选集：已保存标签 ∪ 现有客户组标签（避免手打标签拼错，B11）
        tagOptions: collectTagOptions(gate, groups),
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
    const { locale, plan, gate, groups, tagOptions } = useLoaderData<typeof loader>();
    const t = getT(locale);
    const shopify = useAppBridge();

    const canGate = hasFeature(plan, "gating");
    const canGroups = hasFeature(plan, "customer_groups");

    const gateFetcher = useFetcher<typeof action>();
    const groupFetcher = useFetcher<typeof action>();

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

    useEffect(() => {
        setMode(gate.mode);
        setTags(gate.tags);
    }, [gate]);

    const gateFailed = gateFetcher.data?.ok === false ? gateFetcher.data : null;
    const groupFailed = groupFetcher.data?.ok === false ? groupFetcher.data : null;

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

            {/* ③ 批发价（Pro，B5，M12 落地）：§6.1 空态 */}
            <s-section heading={t("wholesale.prices")}>
                <s-stack direction="block" gap="base">
                    {!hasFeature(plan, "wholesale_price") ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}
                    <PlannedEmptyState
                        heading={t("empty.prices.title")}
                        cta={t("empty.prices.cta")}
                        hint={t("wholesale.comingSoon")}
                    />
                </s-stack>
            </s-section>

            {/* ④ 阶梯价（Pro，M12 落地）：§6.1 空态（含「套用商品级默认档位」次按钮） */}
            <s-section heading={t("wholesale.tiers")}>
                <s-stack direction="block" gap="base">
                    {!hasFeature(plan, "tier_pricing") ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}
                    <PlannedEmptyState
                        heading={t("empty.tiers.title")}
                        body={t("empty.tiers.body")}
                        cta={t("empty.tiers.cta")}
                        secondary={t("empty.tiers.secondary")}
                        hint={t("wholesale.comingSoon")}
                    />
                </s-stack>
            </s-section>

            {/* ⑤ Mix & Match 混单组（Pro，Y13，M12 落地）：§6.1 空态 */}
            <s-section heading={t("wholesale.mixmatch")}>
                <s-stack direction="block" gap="base">
                    {!hasFeature(plan, "mix_match") ? (
                        <ProHint label={t("pro.badge")} upgrade={t("pro.upgrade")} />
                    ) : null}
                    <PlannedEmptyState
                        heading={t("empty.mixmatch.title")}
                        body={t("empty.mixmatch.body")}
                        cta={t("empty.mixmatch.cta")}
                        hint={t("wholesale.comingSoon")}
                    />
                </s-stack>
            </s-section>

            {/* ⑥ 申请（Free 可用，M11 落地）：§6.1 空态 */}
            <s-section heading={t("wholesale.applications")}>
                <PlannedEmptyState
                    heading={t("empty.applications.title")}
                    body={t("empty.applications.body")}
                    cta={t("empty.applications.cta")}
                    hint={t("wholesale.comingSoon")}
                />
            </s-section>
        </s-page>
    );
}