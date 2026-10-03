/**
 * 布局模板（B12）—— 命名模板集，保存 / 设为默认 / 按范围套用
 *
 * 方案 §六「布局模板」：
 *   - 模板 = 命名模板集，保存当前「布局 / 列开关 / 变体规则 / 商品级起订金额」快照；
 *   - 「设为默认」供**新商品继承**（见 tables.server 的 addProductTables）；
 *   - 套用范围 = **全部 / 系列 / 勾选商品**；
 *   - **默认不覆盖已手改的变体规则** —— 只有勾选「一并覆写规则」才覆盖（§十二 验收 28）。
 *
 * P7（§2.3.1）：单次套用最多 BULK_MAX_PRODUCTS 个商品，超限**不静默截断**，
 * 只处理前 N 个并把 `overflow` 如实回报给商家分批重试。
 *
 * 硬约束：`shop` 一律由调用方从 `session` 传入（§8.2 A）。
 */

import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { checkBulkCount } from "../perf-limits";
import type { GraphqlAdmin } from "./metafield.server";
import {
    TablelyError,
    listProductVariants,
    pushProductTableMetafield,
    validateVariantRule,
    type VariantRuleValues,
} from "./tables.server";

export { isTablelyError } from "./tables.server";

/* --------------------------- 模板快照契约 --------------------------- */

/** 模板内的一条变体规则（只在「一并覆写规则」时生效） */
export type TemplateRule = VariantRuleValues & { variantId: string };

/**
 * `LayoutTemplate.payload` 的形状。
 *
 * ⚠️ 版本号独立于商品 metafield 契约：模板是 DB 内的快照，不进店面。
 */
export type LayoutTemplatePayload = {
    v: 1;
    /** 布局覆写；`null` = 继承店铺默认 */
    layout: string | null;
    /** 列开关（M3 不出 UI，随模板原样搬运） */
    columns: Record<string, boolean>;
    /** 快照里的变体规则；勾选「一并覆写规则」时才写入目标商品 */
    rules: TemplateRule[];
    /** 快照里的商品级起订金额；`null` = 不限。同样只在覆写规则时写入 */
    orderMinAmount: string | null;
};

/** 容错解析：历史 / 手改过的 payload 缺字段时补默认，绝不让渲染崩 */
function parsePayload(raw: Prisma.JsonValue | null | undefined): LayoutTemplatePayload {
    const value = (raw ?? {}) as Partial<LayoutTemplatePayload>;
    return {
        v: 1,
        layout: typeof value.layout === "string" ? value.layout : null,
        columns:
            value.columns && typeof value.columns === "object"
                ? (value.columns as Record<string, boolean>)
                : {},
        rules: Array.isArray(value.rules)
            ? value.rules.filter(
                (rule): rule is TemplateRule =>
                    Boolean(rule) && typeof rule.variantId === "string",
            )
            : [],
        orderMinAmount:
            typeof value.orderMinAmount === "string" ? value.orderMinAmount : null,
    };
}

export type LayoutTemplateRecord = {
    id: string;
    name: string;
    isDefault: boolean;
    updatedAt: Date;
    ruleCount: number;
    layout: string | null;
    orderMinAmount: string | null;
};

/* ------------------------------- 读取 ------------------------------- */

export async function listTemplates(shop: string): Promise<LayoutTemplateRecord[]> {
    const rows = await prisma.layoutTemplate.findMany({
        where: { shop },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });

    return rows.map((row) => {
        const payload = parsePayload(row.payload);
        return {
            id: row.id,
            name: row.name,
            isDefault: row.isDefault,
            updatedAt: row.updatedAt,
            ruleCount: payload.rules.length,
            layout: payload.layout,
            orderMinAmount: payload.orderMinAmount,
        };
    });
}

/** 供「新商品继承」使用的默认模板 payload；无默认模板返回 `null` */
export async function getDefaultTemplate(
    shop: string,
): Promise<LayoutTemplatePayload | null> {
    const row = await prisma.layoutTemplate.findFirst({
        where: { shop, isDefault: true },
    });
    return row ? parsePayload(row.payload) : null;
}

/* ------------------------------- 写入 ------------------------------- */

const MAX_TEMPLATE_NAME = 60;

/** 名称归一化：去首尾空白 + 长度校验（`@@unique([shop, name])` 靠 DB 兜底重复） */
function normalizeTemplateName(raw: string | null | undefined): string {
    const name = (raw ?? "").trim();
    if (!name) throw new TablelyError("error.templateNameRequired", "templateName");
    if (name.length > MAX_TEMPLATE_NAME) {
        throw new TablelyError("error.templateNameTooLong", "templateName");
    }
    return name;
}

/**
 * 从某个商品的**当前配置**保存一份模板快照。
 *
 * 该商品必须已配置订购表（否则没有可快照的内容）。
 */
export async function saveTemplateFromProduct(input: {
    shop: string;
    productId: string;
    name: string;
}): Promise<{ id: string; name: string }> {
    const name = normalizeTemplateName(input.name);

    const [table, rules] = await Promise.all([
        prisma.productTable.findUnique({
            where: { shop_productId: { shop: input.shop, productId: input.productId } },
        }),
        prisma.variantRule.findMany({
            where: { shop: input.shop, productId: input.productId },
        }),
    ]);
    if (!table) throw new TablelyError("error.notFound");

    const payload: LayoutTemplatePayload = {
        v: 1,
        layout: table.layout,
        columns: (table.columns ?? {}) as Record<string, boolean>,
        rules: rules.map((rule) => ({
            variantId: rule.variantId,
            min: rule.min,
            max: rule.max,
            step: rule.step,
        })),
        orderMinAmount: table.orderMinAmount ? table.orderMinAmount.toFixed(2) : null,
    };

    try {
        const created = await prisma.layoutTemplate.create({
            data: {
                shop: input.shop,
                name,
                payload: payload as unknown as Prisma.InputJsonValue,
            },
            select: { id: true, name: true },
        });
        return created;
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new TablelyError("error.templateNameTaken", "templateName");
        }
        throw error;
    }
}

/** 设为 / 取消全局默认模板（唯一；同一事务内先清空其余） */
export async function setDefaultTemplate(input: {
    shop: string;
    templateId: string;
    isDefault: boolean;
}): Promise<void> {
    const row = await prisma.layoutTemplate.findUnique({
        where: { id: input.templateId },
        select: { id: true, shop: true },
    });
    if (!row || row.shop !== input.shop) throw new TablelyError("error.notFound");

    await prisma.$transaction([
        prisma.layoutTemplate.updateMany({
            where: { shop: input.shop, isDefault: true },
            data: { isDefault: false },
        }),
        prisma.layoutTemplate.update({
            where: { id: input.templateId },
            data: { isDefault: input.isDefault },
        }),
    ]);
}

export async function deleteTemplate(input: {
    shop: string;
    templateId: string;
}): Promise<void> {
    const row = await prisma.layoutTemplate.findUnique({
        where: { id: input.templateId },
        select: { id: true, shop: true },
    });
    if (!row || row.shop !== input.shop) throw new TablelyError("error.notFound");
    // 模板只是快照，删除不影响任何商品（商品配置不反向引用模板）
    await prisma.layoutTemplate.delete({ where: { id: row.id } });
}

/* ------------------------------- 套用 ------------------------------- */

export type ApplyScope = "all" | "collection" | "selected";

export type ApplyTemplateInput = {
    admin: GraphqlAdmin;
    shop: string;
    templateId: string;
    scope: ApplyScope;
    /** scope = collection 时必填 */
    collectionId?: string | null;
    /** scope = selected 时必填（前端勾选的行；服务端仍会与库内商品求交集） */
    productIds?: string[];
    /** 勾选后才会用模板里的规则 / 起订金额覆盖目标商品（默认 false） */
    overwriteRules: boolean;
};

export type ApplyTemplateResult = {
    /** 实际已套用的商品数 */
    applied: number;
    /** 命中范围但被 P7 上限略过的商品数（> 0 时提示商家分批） */
    overflow: number;
    limit: number;
    /** 目标范围内不在本店已配置商品列表里的 id 数（勾选商品时可能出现） */
    skipped: number;
};

/**
 * 按范围套用模板。
 *
 * 语义（§十二 验收 28）：
 *   - **不勾选**「一并覆写规则」→ 只改布局 / 列开关，**已手改的变体规则与起订金额原样保留**；
 *   - **勾选**后 → 用模板快照覆盖规则与商品级起订金额（规则按目标商品的变体求交集，
 *     不属于该商品的变体一律丢弃）。
 *
 * 每个目标商品改完 DB 后**立即重下发 metafield**，保证店面与后台一致（§2.7）。
 */
export async function applyTemplate(
    input: ApplyTemplateInput,
): Promise<ApplyTemplateResult> {
    const template = await prisma.layoutTemplate.findUnique({
        where: { id: input.templateId },
        select: { shop: true, payload: true },
    });
    if (!template || template.shop !== input.shop) {
        throw new TablelyError("error.notFound");
    }
    const payload = parsePayload(template.payload);

    const configured = await prisma.productTable.findMany({
        where: { shop: input.shop },
        select: { productId: true },
    });
    const configuredIds = configured.map((row) => row.productId);
    const configuredSet = new Set(configuredIds);

    let targetIds: string[];
    let skipped = 0;

    if (input.scope === "all") {
        targetIds = configuredIds;
    } else if (input.scope === "collection") {
        const collectionId = (input.collectionId ?? "").trim();
        if (!collectionId) throw new TablelyError("error.noSelection", "collection");
        const inCollection = await listCollectionProductIds(input.admin, collectionId);
        targetIds = inCollection.filter((id) => configuredSet.has(id));
        skipped = inCollection.length - targetIds.length;
    } else {
        const requested = [...new Set((input.productIds ?? []).map((id) => id.trim()).filter(Boolean))];
        if (requested.length === 0) throw new TablelyError("error.noSelection");
        targetIds = requested.filter((id) => configuredSet.has(id));
        skipped = requested.length - targetIds.length;
    }

    // P7：超限只处理前 N 个，剩下如实回报，绝不静默截断
    const bulk = checkBulkCount(targetIds.length);
    const accepted = targetIds.slice(0, bulk.accepted);

    let applied = 0;
    for (const productId of accepted) {
        await applyTemplateToProduct({
            admin: input.admin,
            shop: input.shop,
            productId,
            payload,
            overwriteRules: input.overwriteRules,
        });
        applied += 1;
    }

    return { applied, overflow: bulk.overflow, limit: bulk.limit, skipped };
}

/** 对单个商品套用模板（DB + metafield） */
async function applyTemplateToProduct(input: {
    admin: GraphqlAdmin;
    shop: string;
    productId: string;
    payload: LayoutTemplatePayload;
    overwriteRules: boolean;
}): Promise<void> {
    let rules: TemplateRule[] = [];

    if (input.overwriteRules) {
        // 规则按目标商品的实际变体求交集（模板来自别的商品，变体 id 大多对不上）
        const variants = await listProductVariants(input.admin, input.productId);
        const variantIds = new Set(variants.map((variant) => variant.id));
        rules = input.payload.rules.filter((rule) => variantIds.has(rule.variantId));
        for (const rule of rules) {
            const problem = validateVariantRule(rule);
            if (problem) throw new TablelyError(problem);
        }
    }

    await prisma.$transaction(async (tx) => {
        await tx.productTable.update({
            where: { shop_productId: { shop: input.shop, productId: input.productId } },
            data: {
                layout: input.payload.layout,
                columns: input.payload.columns as unknown as Prisma.InputJsonValue,
                // 不勾选覆写时**不碰** orderMinAmount，保留商家手改值
                ...(input.overwriteRules
                    ? { orderMinAmount: input.payload.orderMinAmount }
                    : {}),
            },
        });

        if (input.overwriteRules) {
            await tx.variantRule.deleteMany({
                where: { shop: input.shop, productId: input.productId },
            });
            if (rules.length) {
                await tx.variantRule.createMany({
                    data: rules.map((rule) => ({
                        shop: input.shop,
                        productId: input.productId,
                        variantId: rule.variantId,
                        min: rule.min,
                        max: rule.max,
                        step: rule.step,
                    })),
                });
            }
        }
    });

    await pushProductTableMetafield(input);
}

/* ---------------------------- Admin API ---------------------------- */

const COLLECTIONS_QUERY = `#graphql
  query TablelyCollections($first: Int!) {
    collections(first: $first, sortKey: TITLE) {
      nodes {
        id
        title
      }
    }
  }
`;

export type ShopifyCollectionRow = { id: string; title: string };

/** 系列列表（套用范围的「系列」下拉） */
export async function listCollections(
    admin: GraphqlAdmin,
): Promise<ShopifyCollectionRow[]> {
    const res = await admin.graphql(COLLECTIONS_QUERY, { variables: { first: 100 } });
    const json = await res.json();
    assertNoGraphqlErrors(json, "listCollections");
    const nodes =
        (json as { data?: { collections?: { nodes?: { id: string; title?: string }[] } } })
            ?.data?.collections?.nodes ?? [];
    return nodes.map((node) => ({ id: node.id, title: node.title ?? "" }));
}

const COLLECTION_PRODUCTS_QUERY = `#graphql
  query TablelyCollectionProducts($id: ID!, $first: Int!) {
    collection(id: $id) {
      products(first: $first) {
        nodes {
          id
        }
      }
    }
  }
`;

/** 系列内商品 id（单页 250，Admin 上限；超出部分属 M13 的分页细化） */
async function listCollectionProductIds(
    admin: GraphqlAdmin,
    collectionId: string,
): Promise<string[]> {
    const res = await admin.graphql(COLLECTION_PRODUCTS_QUERY, {
        variables: { id: collectionId, first: 250 },
    });
    const json = await res.json();
    assertNoGraphqlErrors(json, "listCollectionProductIds");
    const nodes =
        (json as {
            data?: { collection?: { products?: { nodes?: { id: string }[] } } | null };
        })?.data?.collection?.products?.nodes ?? [];
    return nodes.map((node) => node.id);
}

function assertNoGraphqlErrors(json: unknown, context: string) {
    const errors = (json as { errors?: { message: string }[] })?.errors;
    if (Array.isArray(errors) && errors.length) {
        throw new Error(
            `[tablely] ${context}: ${errors.map((error) => error.message).join("; ")}`,
        );
    }
}

/** Prisma 唯一键冲突（P2002）：模板重名靠 DB 兜底 */
function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: string }).code === "P2002"
    );
}

