/**
 * 自动折扣维护（M12，§2.2.1 / §2.2.2）
 *
 * 每店 **3 个** automatic discount（阶梯价 / 批发价 / Mix & Match），全部指向同一个
 * Function `tablely-pricing`（targeting `cart.lines.discounts.generate.run`），靠各自
 * **function metafield** 的 `mode` 区分行为：
 *
 *   | discount 节点 | 记录字段（DiscountState） | mode       | config metafield |
 *   |---|---|---|---|
 *   | 阶梯价 | `tierDiscountId` | `tier` | `enabled`(受 `ShopSettings.tierEnabled`) + `groupTags` + `mixGroups` |
 *   | 批发价 | `wholeDiscountId` | `wholesale` | `groupTags` |
 *   | 混单 | `mixMatchDiscountId` | `mixmatch` | `groupTags` + `mixGroups` |
 *
 * 两条配置投递路（§2.2.1）：
 *   ① **product metafield**（`tablely.table`）—— 各变体的档位 / 批发价，由
 *      `tables.server.pushProductTableMetafield` 下发（改档位**无需重新部署**）；
 *   ② **discount function metafield**（namespace `$app:tablely`）—— 全局项与混单全量映射：
 *      · `config`    —— 本 discount 的 `mode` / 开关 / 客户组标签 / 混单组；
 *      · `variables` —— `[extensions.input.variables]` 声明的输入变量载体
 *        （`{"customerTags":[...]}`，Function 侧按此查 `customer.hasTags`）。
 *
 * ⚠️ **依赖方向**：本模块 import `billing.server`（复用 `syncDiscountsForPlan` 做降级/恢复启停），
 *    `billing.server` **不得**反向 import 本模块（避免循环依赖）。
 */

import prisma from "../db.server";
import type { Plan } from "../plan";
import { logStructured } from "./monitor.server";
import {
    checkDiscountIntegrity,
    type DiscountRef,
    type IntegrityIssue,
} from "./monitor.server";
import { normalizeTiers, type GraphqlAdmin } from "./metafield.server";
import { syncDiscountsForPlan } from "./billing.server";
import { gidToNumericId, resolvePlan } from "./tables.server";

/* ================================ 常量 ================================ */

/** Function 的 targeting apiType（与 `shopify.extension.toml` 一致） */
export const DISCOUNT_API_TYPE = "cart.lines.discounts.generate.run";

/** 扩展 handle（`shopify.extension.toml` 的 `handle`） */
export const PRICING_FUNCTION_HANDLE = "tablely-pricing";

/** discount function metafield 的 namespace（应用预留命名空间，§五） */
export const PRICING_NAMESPACE = "$app:tablely";
export const CONFIG_KEY = "config";
export const VARIABLES_KEY = "variables";

export type PricingMode = "tier" | "wholesale" | "mixmatch";

type DiscountSlot = "tierDiscountId" | "wholeDiscountId" | "mixMatchDiscountId";

/** 三个折扣的定义（顺序即「创建 / 更新 / 巡检」的处理顺序） */
const DISCOUNT_DEFS: {
    slot: DiscountSlot;
    mode: PricingMode;
    title: string;
}[] = [
    { slot: "tierDiscountId", mode: "tier", title: "Tablely tier pricing" },
    { slot: "wholeDiscountId", mode: "wholesale", title: "Tablely wholesale pricing" },
    { slot: "mixMatchDiscountId", mode: "mixmatch", title: "Tablely Mix & Match" },
];

/* ============================== GraphQL ============================== */

const FUNCTIONS_QUERY = `#graphql
  query TablelyPricingFunctions($apiType: String!) {
    shopifyFunctions(apiType: $apiType, first: 50) {
      nodes {
        handle
        title
      }
    }
  }
`;

const CREATE_MUTATION = `#graphql
  mutation TablelyCreateAutomaticDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount {
        discountId
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const UPDATE_MUTATION = `#graphql
  mutation TablelyUpdateAutomaticDiscount(
    $id: ID!
    $automaticAppDiscount: DiscountAutomaticAppInput!
  ) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount {
        discountId
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DISCOUNT_QUERY = `#graphql
  query TablelyAutomaticDiscount($id: ID!) {
    automaticDiscountNode(id: $id) {
      id
      automaticDiscount {
        ... on DiscountAutomaticApp {
          status
        }
      }
    }
  }
`;

type UserError = { field?: string[]; message: string; code?: string };

function throwOnGraphqlErrors(json: unknown, context: string): void {
    const errors = (json as { errors?: { message: string }[] } | null)?.errors;
    if (Array.isArray(errors) && errors.length) {
        throw new Error(
            `[tablely] ${context}: ${errors.map((error) => error.message).join("; ")}`,
        );
    }
}

function throwOnUserErrors(
    userErrors: UserError[] | undefined,
    context: string,
): void {
    if (!userErrors?.length) return;
    throw new Error(
        `[tablely] ${context}: ${userErrors
            .map((error) => [...(error.field ?? []), error.message].join(" "))
            .join("; ")}`,
    );
}

/**
 * 定位本应用的折扣 Function handle。
 *
 * 部署后 `shopifyFunctions(apiType:)` 会返回本应用拥有的该 apiType function；
 * 取不到（未部署 / apiType 拼错）时**必须显式报错**，否则会创建出「不生效」的折扣。
 */
export async function getPricingFunctionHandle(
    admin: GraphqlAdmin,
): Promise<string> {
    const res = await admin.graphql(FUNCTIONS_QUERY, {
        variables: { apiType: DISCOUNT_API_TYPE },
    });
    const json = (await res.json()) as {
        errors?: { message: string }[];
        data?: { shopifyFunctions?: { nodes?: { handle?: string; title?: string }[] } };
    };
    throwOnGraphqlErrors(json, "getPricingFunctionHandle");

    const nodes = json.data?.shopifyFunctions?.nodes ?? [];
    const matched = nodes.find((node) => node.handle === PRICING_FUNCTION_HANDLE);
    if (matched?.handle) return matched.handle;
    // 兜底：本 apiType 下只注册了一个 function 时，直接采用它
    const single = nodes.length === 1 ? nodes[0]?.handle : null;
    if (single) return single;

    throw new Error(
        `[tablely] getPricingFunctionHandle: 未找到 handle=${PRICING_FUNCTION_HANDLE} 的折扣 Function（请确认已部署 tablely-pricing 扩展）`,
    );
}

/** 查某个 automatic discount 的实时状态；不存在（被人工删掉）返回 `null` */
export async function fetchDiscountStatus(
    admin: GraphqlAdmin,
    id: string,
): Promise<string | null> {
    const res = await admin.graphql(DISCOUNT_QUERY, { variables: { id } });
    const json = (await res.json()) as {
        errors?: { message: string }[];
        data?: {
            automaticDiscountNode?: {
                id?: string;
                automaticDiscount?: { status?: string };
            } | null;
        };
    };
    throwOnGraphqlErrors(json, "fetchDiscountStatus");

    const node = json.data?.automaticDiscountNode;
    if (!node?.id) return null;
    return node.automaticDiscount?.status ?? "UNKNOWN";
}

/* ========================= 配置构建（纯函数） ========================= */

export type MixGroupInput = { id: string; tiers: unknown; vids: string[] };

export type PricingInputs = {
    /** 阶梯价总开关（`ShopSettings.tierEnabled`） */
    tierEnabled: boolean;
    /** 全部客户组标签（CustomerGroup.tag ∪ gateTags）—— 用于判定「批发客户」并作为输入变量 */
    groupTags: string[];
    /** 已启用的混单组（含档位与组内变体 numeric id） */
    mixGroups: MixGroupInput[];
};

export type PricingConfigBuilt = {
    slot: DiscountSlot;
    mode: PricingMode;
    title: string;
    /** `config` metafield 的 JSON 字符串 */
    value: string;
};

/** 混单组归一化：`{key, tiers, vids}`（`key` 仅用于标识；Function 只读 `tiers` / `vids`） */
function toMixGroupPayload(groups: MixGroupInput[]) {
    return groups
        .map((group) => ({
            key: group.id,
            tiers: normalizeTiers(group.tiers),
            vids: group.vids.map((vid) => String(vid)),
        }))
        .filter((group) => group.vids.length > 0 && group.tiers.length > 0);
}

/**
 * 由 DB 输入构建三份 config + `variables` metafield 值（**纯函数**，供单测）。
 *
 * ⚠️ 三份 config 的差异是**刻意**的：
 *   · 阶梯价必须带 `mixGroups` —— Function 要在「混单已命中」时**跳过**这些行（混单优先）；
 *   · 批发价不需要 `mixGroups`（批发价按变体直接命中，与混单互斥由阶梯价侧处理）；
 *   · 三份都必须带 `groupTags` —— Function 据此判定「批发客户」，令其不享阶梯价 / 混单价。
 */
export function buildPricingConfigs(input: PricingInputs): {
    configs: PricingConfigBuilt[];
    variablesValue: string;
} {
    const groupTags = [
        ...new Set(input.groupTags.map((tag) => tag.trim()).filter(Boolean)),
    ];
    const mixGroups = toMixGroupPayload(input.mixGroups);

    const body = {
        tier: {
            mode: "tier" as const,
            enabled: input.tierEnabled,
            groupTags,
            mixGroups,
        },
        wholesale: {
            mode: "wholesale" as const,
            enabled: true,
            groupTags,
            mixGroups: [],
        },
        mixmatch: {
            mode: "mixmatch" as const,
            enabled: true,
            groupTags,
            mixGroups,
        },
    };

    const configs = DISCOUNT_DEFS.map((def) => ({
        slot: def.slot,
        mode: def.mode,
        title: def.title,
        value: JSON.stringify(body[def.mode]),
    }));

    return {
        configs,
        // `[extensions.input.variables]` 读取的 JSON：顶层 key = 查询变量名
        variablesValue: JSON.stringify({ customerTags: groupTags }),
    };
}

/** 读 DB 现状 → 构建配置所需的输入（客户组标签 / 混单组 / 阶梯价开关） */
export async function loadPricingInputs(shop: string): Promise<PricingInputs> {
    const [settings, groups, mixGroups, members] = await Promise.all([
        prisma.shopSettings.findUnique({
            where: { shop },
            select: { tierEnabled: true, gateTags: true },
        }),
        prisma.customerGroup.findMany({ where: { shop }, select: { tag: true } }),
        prisma.mixMatchGroup.findMany({
            where: { shop, enabled: true },
            select: { id: true, tiers: true },
        }),
        prisma.mixMatchMember.findMany({
            where: { shop },
            select: { groupId: true, variantId: true },
        }),
    ]);

    const tags = new Set<string>();
    for (const group of groups) {
        if (group.tag?.trim()) tags.add(group.tag.trim());
    }
    for (const tag of settings?.gateTags ?? []) {
        if (tag?.trim()) tags.add(tag.trim());
    }

    const vidsByGroup = new Map<string, string[]>();
    for (const member of members) {
        const list = vidsByGroup.get(member.groupId) ?? [];
        list.push(gidToNumericId(member.variantId));
        vidsByGroup.set(member.groupId, list);
    }

    return {
        tierEnabled: settings?.tierEnabled ?? false,
        groupTags: [...tags],
        mixGroups: mixGroups.map((group) => ({
            id: group.id,
            tiers: group.tiers,
            vids: vidsByGroup.get(group.id) ?? [],
        })),
    };
}

/* ============================ 创建 / 更新 ============================ */

type OwnerMetafield = {
    namespace: string;
    key: string;
    type: string;
    value: string;
};

/** `DiscountAutomaticAppInput`：Product 类 + 不与任何其它折扣合并（§2.2.2 三项全 false） */
function discountInput(
    handle: string,
    title: string,
    metafields: OwnerMetafield[],
): Record<string, unknown> {
    return {
        title,
        functionHandle: handle,
        discountClasses: ["PRODUCT"],
        combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
        },
        metafields,
    };
}

async function createDiscount(
    admin: GraphqlAdmin,
    input: Record<string, unknown>,
): Promise<string> {
    const res = await admin.graphql(CREATE_MUTATION, {
        variables: { automaticAppDiscount: input },
    });
    const json = (await res.json()) as {
        errors?: { message: string }[];
        data?: {
            discountAutomaticAppCreate?: {
                automaticAppDiscount?: { discountId?: string };
                userErrors?: UserError[];
            };
        };
    };
    throwOnGraphqlErrors(json, "createDiscount");
    const payload = json.data?.discountAutomaticAppCreate;
    throwOnUserErrors(payload?.userErrors, "createDiscount");
    const id = payload?.automaticAppDiscount?.discountId;
    if (!id) throw new Error("[tablely] createDiscount: 未返回 discountId");
    return id;
}

async function updateDiscount(
    admin: GraphqlAdmin,
    id: string,
    input: Record<string, unknown>,
): Promise<void> {
    const res = await admin.graphql(UPDATE_MUTATION, {
        variables: { id, automaticAppDiscount: input },
    });
    const json = (await res.json()) as {
        errors?: { message: string }[];
        data?: {
            discountAutomaticAppUpdate?: { userErrors?: UserError[] };
        };
    };
    throwOnGraphqlErrors(json, "updateDiscount");
    throwOnUserErrors(
        json.data?.discountAutomaticAppUpdate?.userErrors,
        "updateDiscount",
    );
}

/** 写回 3 个折扣 id（增量保存：单个创建成功即落库，重试时可复用） */
async function persistDiscountIds(
    shop: string,
    ids: Record<DiscountSlot, string | null>,
): Promise<void> {
    await prisma.discountState.upsert({
        where: { shop },
        create: {
            shop,
            tierDiscountId: ids.tierDiscountId,
            wholeDiscountId: ids.wholeDiscountId,
            mixMatchDiscountId: ids.mixMatchDiscountId,
        },
        update: {
            tierDiscountId: ids.tierDiscountId,
            wholeDiscountId: ids.wholeDiscountId,
            mixMatchDiscountId: ids.mixMatchDiscountId,
        },
    });
}

export type DiscountSyncResult = {
    handle: string;
    created: number;
    updated: number;
    /** 同步后 3 个折扣是否处于 active（= 当前为 Pro） */
    active: boolean;
};

/**
 * 确保本店 3 个 automatic discount 存在且配置为最新（**幂等**）。
 *
 * - 每个 slot：DB 有 id → `update`（刷新 config/variables metafield，**改规则无需重新部署**）；
 *   无 id → `create`；
 * - 记录里的 id 在 Shopify 侧已被**人工删除**时，改为重建（先探测存在性再决定，
 *   避免把「限流等瞬时错误」误判为不存在而产生重复折扣）；
 * - 全部落库后调 `syncDiscountsForPlan`：Pro → active、Free → inactive（§2.2.2 / §19.3）；
 * - 任何一步失败**显式抛错**（§六），已成功的 id 已增量落库，重试即续。
 */
export async function ensureDiscountsForShop(input: {
    admin: GraphqlAdmin;
    shop: string;
    plan?: Plan;
}): Promise<DiscountSyncResult> {
    const { admin, shop } = input;
    const handle = await getPricingFunctionHandle(admin);
    const { configs, variablesValue } = buildPricingConfigs(
        await loadPricingInputs(shop),
    );
    const variablesMetafield: OwnerMetafield = {
        namespace: PRICING_NAMESPACE,
        key: VARIABLES_KEY,
        type: "json",
        value: variablesValue,
    };

    const existing = await prisma.discountState.findUnique({ where: { shop } });
    const ids: Record<DiscountSlot, string | null> = {
        tierDiscountId: existing?.tierDiscountId ?? null,
        wholeDiscountId: existing?.wholeDiscountId ?? null,
        mixMatchDiscountId: existing?.mixMatchDiscountId ?? null,
    };

    let created = 0;
    let updated = 0;

    for (const config of configs) {
        const appInput = discountInput(handle, config.title, [
            {
                namespace: PRICING_NAMESPACE,
                key: CONFIG_KEY,
                type: "json",
                value: config.value,
            },
            variablesMetafield,
        ]);
        const currentId = ids[config.slot];

        if (currentId) {
            try {
                await updateDiscount(admin, currentId, appInput);
                updated += 1;
            } catch (error) {
                // 仅当确认「店铺里真的没有这条折扣」才重建，否则原样抛出（避免重复折扣）
                const status = await fetchDiscountStatus(admin, currentId);
                if (status !== null) throw error;
                logStructured("warn", "discounts.recreate_missing", {
                    shop,
                    slot: config.slot,
                    discountId: currentId,
                });
                ids[config.slot] = await createDiscount(admin, appInput);
                created += 1;
            }
        } else {
            ids[config.slot] = await createDiscount(admin, appInput);
            created += 1;
        }

        await persistDiscountIds(shop, ids);
    }

    const plan = input.plan ?? (await resolvePlan(shop));
    await syncDiscountsForPlan(admin, shop, plan);

    logStructured("info", "discounts.ensured", {
        shop,
        created,
        updated,
        plan,
    });

    return { handle, created, updated, active: plan === "pro" };
}

/* =============================== 巡检 =============================== */

/**
 * 读店铺实时折扣状态并与记录比对（§21.5 业务完整性层）。
 *
 * 这是 `runDailyDiscountIntegrityCheck` 所需 `listLiveDiscounts` 的真实数据源；
 * 调度（每日一次）由监控侧负责，本函数只做「查 + 判」。
 */
export async function auditDiscounts(input: {
    admin: GraphqlAdmin;
    shop: string;
    plan: string;
}): Promise<IntegrityIssue[]> {
    const { admin, shop, plan } = input;
    const state = await prisma.discountState.findUnique({ where: { shop } });

    const ids = state
        ? [
              state.tierDiscountId,
              state.wholeDiscountId,
              state.mixMatchDiscountId,
          ].filter((id): id is string => Boolean(id))
        : [];

    const liveDiscounts: DiscountRef[] = [];
    for (const id of ids) {
        const status = await fetchDiscountStatus(admin, id).catch(() => null);
        if (status !== null) liveDiscounts.push({ id, status });
    }

    return checkDiscountIntegrity({ shop, plan, state, liveDiscounts });
}