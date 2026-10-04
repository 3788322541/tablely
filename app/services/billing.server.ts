/**
 * Billing 与档位同步（M9，方案 §七 / §19）
 *
 * 档位判定统一落在 `PlanState.plan`（全店唯一档位源），本文件负责：
 *   ① 向 Shopify 查 `currentAppInstallation.activeSubscriptions`（权威值）；
 *   ② 调 `appSubscriptionCreate` 拿托管确认页 URL；
 *   ③ 把权威值回写到 `PlanState`（plan / trialEndsAt / syncedAt / everPro）；
 *   ④ **档位变更时同步 3 个 automatic discount 的启停**（§2.2.2 / §19.3）——
 *      降级置 `inactive`、恢复置 `active`，**复用已存在的记录，绝不重复创建**。
 *
 * 两条回写路径（沿用 Attributly / Linkly 已验证做法）：
 *   - 实时：`app_subscriptions/update` webhook → `applySubscriptionWebhook`；
 *   - 兜底：进入后台（app.tsx shell loader）走 `maybePlanDailySync`，距上次查询 >24h 才真打 Shopify。
 *
 * ⚠️ 本文件 import 了 `db.server` / `tables.server`，**只能被路由 / 其它 server 模块引用**；
 * 组件（客户端包）要用的纯函数一律放 `app/plan.ts`。
 */

import prisma from "../db.server";
import {
    PLAN_OPTIONS,
    TRIAL_DAYS,
    normalizePlan,
    type Plan,
    type PlanKey,
} from "../plan";
import { logStructured } from "./monitor.server";
import type { GraphqlAdmin } from "./metafield.server";
import { FREE_PRODUCT_LIMIT } from "./tables.server";

/** Shopify 认为「订阅有效」的状态：试用中与已激活都算 Pro */
export function isActiveStatus(status: string): boolean {
    const value = status.toUpperCase();
    return value === "ACTIVE" || value === "TRIALING";
}

/**
 * 是否走 Shopify 测试单（不真实扣费）。
 * 开发店必须 true，否则 appSubscriptionCreate 会直接返回 userErrors。
 * BILLING_TEST 显式配置优先，未配置时按 NODE_ENV 推断。
 */
export function billingTestMode(): boolean {
    if (process.env.BILLING_TEST) return process.env.BILLING_TEST !== "false";
    return process.env.NODE_ENV !== "production";
}

/* ------------------------------- GraphQL ------------------------------- */

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query TablelyActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        trialDays
        currentPeriodEnd
      }
    }
  }
`;

const CREATE_SUBSCRIPTION_MUTATION = `#graphql
  mutation TablelyCreateSubscription(
    $name: String!
    $returnUrl: URL!
    $test: Boolean!
    $trialDays: Int!
    $amount: Decimal!
    $interval: AppPricingInterval!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: $amount, currencyCode: USD }
              interval: $interval
            }
          }
        }
      ]
    ) {
      confirmationUrl
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ACTIVATE_DISCOUNT_MUTATION = `#graphql
  mutation TablelyActivateDiscount($id: ID!) {
    discountAutomaticActivate(id: $id) {
      automaticDiscountNode {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DEACTIVATE_DISCOUNT_MUTATION = `#graphql
  mutation TablelyDeactivateDiscount($id: ID!) {
    discountAutomaticDeactivate(id: $id) {
      automaticDiscountNode {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type UserError = { field?: string[]; message: string };

export type ActiveSubscription = {
    id: string;
    name: string | null;
    status: string;
    trialDays: number | null;
    /** TRIALING 时 = 试用结束时间；ACTIVE 时 = 当前计费周期结束时间 */
    currentPeriodEnd: string | null;
};

/** 查当前有效订阅（ACTIVE / TRIALING），没有则 null */
export async function getActiveSubscription(
    admin: GraphqlAdmin,
): Promise<ActiveSubscription | null> {
    const res = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
    const json = (await res.json()) as {
        data?: { currentAppInstallation?: { activeSubscriptions?: ActiveSubscription[] } };
    };
    const list = json?.data?.currentAppInstallation?.activeSubscriptions ?? [];
    return list.find((item) => isActiveStatus(item.status)) ?? null;
}

/**
 * 创建订阅，返回 Shopify 托管确认页 URL。
 * ⚠️ 必须跳出 App Bridge 的 iframe 才能打开它（见 app.plans.tsx 的 401 响应头写法）。
 */
export async function createSubscription(
    admin: GraphqlAdmin,
    input: { planKey: PlanKey; returnUrl: string; test: boolean },
): Promise<string> {
    const option = PLAN_OPTIONS[input.planKey];
    const res = await admin.graphql(CREATE_SUBSCRIPTION_MUTATION, {
        variables: {
            name: option.label,
            returnUrl: input.returnUrl,
            test: input.test,
            trialDays: TRIAL_DAYS,
            amount: option.amount,
            interval: option.interval,
        },
    });
    const json = (await res.json()) as {
        errors?: { message: string }[];
        data?: {
            appSubscriptionCreate?: {
                confirmationUrl?: string;
                userErrors?: UserError[];
            };
        };
    };
    if (Array.isArray(json.errors) && json.errors.length) {
        throw new Error(json.errors.map((error) => error.message).join("; "));
    }
    const userErrors = json?.data?.appSubscriptionCreate?.userErrors ?? [];
    if (userErrors.length) {
        throw new Error(
            userErrors
                .map((error) => [...(error.field ?? []), error.message].join(" "))
                .join("; "),
        );
    }
    const confirmationUrl = json?.data?.appSubscriptionCreate?.confirmationUrl;
    if (!confirmationUrl) {
        throw new Error("appSubscriptionCreate 未返回 confirmationUrl");
    }
    return confirmationUrl;
}

/* ----------------------------- 档位回写 ----------------------------- */

export type PlanStateSnapshot = {
    plan: Plan;
    trialEndsAt: Date | null;
    everPro: boolean;
    winbackSeenAt: Date | null;
};

/** 读档位快照（无记录即 Free） */
export async function readPlanState(shop: string): Promise<PlanStateSnapshot> {
    const row = await prisma.planState.findUnique({ where: { shop } });
    return {
        plan: normalizePlan(row?.plan),
        trialEndsAt: row?.trialEndsAt ?? null,
        everPro: row?.everPro ?? false,
        winbackSeenAt: row?.winbackSeenAt ?? null,
    };
}

type DiscountSlot = "tierDiscountId" | "wholeDiscountId" | "mixMatchDiscountId";

const DISCOUNT_SLOTS: DiscountSlot[] = [
    "tierDiscountId",
    "wholeDiscountId",
    "mixMatchDiscountId",
];

/** 逐个调用启停 mutation；单个失败只记日志，不中断其余（§19.4 ④ 尽力而为） */
async function runDiscountMutations(
    admin: GraphqlAdmin,
    ids: string[],
    activate: boolean,
    shop: string,
): Promise<number> {
    const mutation = activate
        ? ACTIVATE_DISCOUNT_MUTATION
        : DEACTIVATE_DISCOUNT_MUTATION;
    const key = activate ? "discountAutomaticActivate" : "discountAutomaticDeactivate";

    let ok = 0;
    for (const id of ids) {
        try {
            const res = await admin.graphql(mutation, { variables: { id } });
            const json = (await res.json()) as {
                errors?: { message: string }[];
                data?: Record<string, { userErrors?: UserError[] } | undefined>;
            };
            if (Array.isArray(json.errors) && json.errors.length) {
                throw new Error(json.errors.map((error) => error.message).join("; "));
            }
            const userErrors = json.data?.[key]?.userErrors ?? [];
            if (userErrors.length) {
                throw new Error(userErrors.map((error) => error.message).join("; "));
            }
            ok += 1;
        } catch (error) {
            logStructured("warn", "billing.discount_sync_failed", {
                shop,
                discountId: id,
                action: activate ? "activate" : "deactivate",
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return ok;
}

/**
 * 按档位同步 3 个 automatic discount 的启停（§2.2.2 / §19.3）。
 *
 * - **复用已存在的记录**：只对 `DiscountState` 里已登记的 id 调启停，
 *   绝不在这里 `discountAutomaticCreate`（那是 M12 的职责，避免重复创建）；
 * - 无记录 / 无 id → 直接返回（Free 店从未建折扣、或 M12 前）；
 * - `active` 标记写回 DB，供额度条 / 巡检 / 挽回条计数使用。
 */
export async function syncDiscountsForPlan(
    admin: GraphqlAdmin,
    shop: string,
    plan: Plan,
): Promise<{ ids: number; updated: number }> {
    const state = await prisma.discountState.findUnique({ where: { shop } });
    if (!state) return { ids: 0, updated: 0 };

    const slots = DISCOUNT_SLOTS.map((slot) => ({ slot, id: state[slot] })).filter(
        (item): item is { slot: DiscountSlot; id: string } => Boolean(item.id),
    );
    if (slots.length === 0) return { ids: 0, updated: 0 };

    const activate = plan === "pro";
    const updated = await runDiscountMutations(
        admin,
        slots.map((item) => item.id),
        activate,
        shop,
    );

    await prisma.discountState.update({
        where: { shop },
        data: { active: activate, syncedAt: new Date() },
    });

    return { ids: slots.length, updated };
}

/**
 * 向 Shopify 查一次并回写档位（权威值覆盖本地快照）。
 *
 * `trialEndsAt` 只在 TRIALING 时写 `currentPeriodEnd`（试用结束时间）；
 * ACTIVE 时它是计费周期结束时间，不能当试用期用，故置 `null`。
 * 档位发生**变化**时才同步折扣启停（幂等：同值重复调用不触发 Shopify 写）。
 */
export async function syncPlanFromShopify(
    admin: GraphqlAdmin,
    shop: string,
): Promise<Plan> {
    const active = await getActiveSubscription(admin);
    const plan: Plan = active ? "pro" : "free";
    const now = new Date();
    const trialing = active ? active.status.toUpperCase() === "TRIALING" : false;
    const trialEndsAt =
        trialing && active?.currentPeriodEnd ? new Date(active.currentPeriodEnd) : null;

    const prev = await prisma.planState.findUnique({
        where: { shop },
        select: { plan: true, everPro: true },
    });
    const prevPlan = normalizePlan(prev?.plan);

    await prisma.planState.upsert({
        where: { shop },
        create: { shop, plan, trialEndsAt, syncedAt: now, everPro: plan === "pro" },
        update: {
            plan,
            trialEndsAt,
            syncedAt: now,
            ...(plan === "pro" && !prev?.everPro ? { everPro: true } : {}),
        },
    });

    if (prevPlan !== plan) {
        await syncDiscountsForPlan(admin, shop, plan);
        logStructured("info", "billing.plan_changed", { shop, from: prevPlan, to: plan });
    } else {
        logStructured("info", "billing.plan_synced", { shop, plan });
    }

    return plan;
}

/** 两次兜底查询之间的最小间隔（§七：>24h 才查一次） */
const PLAN_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 进入后台时的兜底同步：距上次查询超过 24h 才真打 Shopify。
 * 失败不抛——档位兜底失败不该让整个后台 500（webhook 才是主路径）。
 */
export async function maybePlanDailySync(
    admin: GraphqlAdmin,
    shop: string,
): Promise<void> {
    const row = await prisma.planState.findUnique({
        where: { shop },
        select: { syncedAt: true },
    });
    const last = row?.syncedAt?.getTime() ?? 0;
    if (Date.now() - last < PLAN_SYNC_INTERVAL_MS) return;

    try {
        await syncPlanFromShopify(admin, shop);
    } catch (error) {
        logStructured("warn", "billing.plan_sync_failed", {
            shop,
            reason: error instanceof Error ? error.message : String(error),
        });
    }
}

/* --------------------------- Webhook 回写 --------------------------- */

type SubscriptionPayload = {
    app_subscription?: {
        admin_graphql_api_id?: string;
        name?: string;
        status?: string;
    };
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
};

/**
 * `app_subscriptions/update` 回写（实时主路径）。
 *
 * ACTIVE | TRIALING → pro；CANCELLED | EXPIRED | DECLINED | FROZEN → free。
 * ⚠️ webhook 的 payload **没有** currentPeriodEnd，故这里**不动** `trialEndsAt`
 *    （那是 `syncPlanFromShopify` 写下的试用结束时间，抹掉会让「还剩几天」失真）。
 *
 * 档位变化时同步折扣启停；`admin` 由调用方通过离线会话取得，取不到时跳过 Shopify 侧
 * （DB 侧标记仍写，`shop/redact` 与每日巡检会兜底）。
 */
export async function applySubscriptionWebhook(
    shop: string,
    payload: unknown,
    admin?: GraphqlAdmin | null,
): Promise<Plan> {
    const p = (payload ?? {}) as SubscriptionPayload;
    const node = p.app_subscription ?? p;

    const status = String(node.status ?? "").toUpperCase();
    if (!status) throw new Error("app_subscriptions/update 缺少 status");

    const plan: Plan = isActiveStatus(status) ? "pro" : "free";
    const prev = await prisma.planState.findUnique({
        where: { shop },
        select: { plan: true, everPro: true },
    });
    const prevPlan = normalizePlan(prev?.plan);

    await prisma.planState.upsert({
        where: { shop },
        create: { shop, plan, everPro: plan === "pro", syncedAt: new Date() },
        update: {
            plan,
            syncedAt: new Date(),
            ...(plan === "pro" && !prev?.everPro ? { everPro: true } : {}),
        },
    });

    if (prevPlan !== plan && admin) {
        await syncDiscountsForPlan(admin, shop, plan);
    }

    return plan;
}

/* --------------------------- 挽回 / 门控数据 --------------------------- */

export type PlanStatus = {
    plan: Plan;
    /** 试用剩余天数（向上取整，最小 0）；非试用期时为 null */
    trialDaysLeft: number | null;
    /** 是否处于「试用将尽」窗口（剩余 1–2 天，§19.4 触点①） */
    trialEndingSoon: boolean;
};

/**
 * 读取横幅 / 提示条所需信息（纯读库，不打 Shopify）。
 * 以 `trialEndsAt` 为准——它来自 Shopify 的 `currentPeriodEnd`，比固定 7 天准确。
 */
export async function readPlanStatus(shop: string): Promise<PlanStatus> {
    const state = await readPlanState(shop);
    let trialDaysLeft: number | null = null;
    if (state.plan === "pro" && state.trialEndsAt) {
        const ms = state.trialEndsAt.getTime() - Date.now();
        trialDaysLeft = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
    }
    return {
        plan: state.plan,
        trialDaysLeft,
        trialEndingSoon:
            trialDaysLeft !== null && trialDaysLeft >= 1 && trialDaysLeft <= 2,
    };
}

export type WinbackSummary = {
    /** 已暂停的自动折扣数（降级后应为 3；M12 前可能为 0） */
    discountsPaused: number;
    /** 因超出 Free 额度而只读的商品数 */
    productsReadOnly: number;
    /** 已保留但被锁定的 Pro 设置项数 */
    featuresLocked: number;
    /** 是否处于「降级且未关闭说明卡」状态（§19.4 触点②） */
    showSummary: boolean;
};

/**
 * 计算挽回条 / 说明卡里的**真实数字**（§19.4：数字实时从 DB 计算，不写死）。
 * `plan` 非 Free 时全部为 0。
 */
export async function getWinbackSummary(shop: string): Promise<WinbackSummary> {
    const state = await readPlanState(shop);
    if (state.plan === "pro") {
        return {
            discountsPaused: 0,
            productsReadOnly: 0,
            featuresLocked: 0,
            showSummary: false,
        };
    }

    const [enabled, discountState, templates, shopSettings, tables] = await Promise.all([
        prisma.productTable.count({ where: { shop, enabled: true } }),
        prisma.discountState.findUnique({ where: { shop } }),
        prisma.layoutTemplate.count({ where: { shop } }),
        prisma.shopSettings.findUnique({
            where: { shop },
            select: { orderMinAmount: true, theme: true, outOfStockMode: true },
        }),
        prisma.productTable.findMany({
            where: { shop },
            select: { layout: true, orderMinAmount: true },
        }),
    ]);

    const discountIds = discountState
        ? DISCOUNT_SLOTS.filter((slot) => Boolean(discountState[slot])).length
        : 0;
    const discountsPaused = discountState && !discountState.active ? discountIds : 0;
    const productsReadOnly = Math.max(0, enabled - FREE_PRODUCT_LIMIT);

    const style = (shopSettings?.theme ?? {}) as Record<string, unknown>;
    const styleCustomized =
        Boolean(style.brandColor) ||
        Boolean(style.radius) ||
        (typeof style.density === "string" && style.density !== "default") ||
        (typeof style.font === "string" && style.font !== "inherit");

    let featuresLocked = templates;
    if (shopSettings?.orderMinAmount) featuresLocked += 1;
    if (shopSettings?.outOfStockMode && shopSettings.outOfStockMode !== "gray") {
        featuresLocked += 1;
    }
    if (styleCustomized) featuresLocked += 1;
    featuresLocked += tables.filter((table) => Boolean(table.orderMinAmount)).length;

    return {
        discountsPaused,
        productsReadOnly,
        featuresLocked,
        showSummary: state.everPro && state.winbackSeenAt === null,
    };
}

/** 关闭降级说明卡（「先按 Free 用」）——只提示一次（§19.4 触点②） */
export async function markWinbackSeen(shop: string): Promise<void> {
    await prisma.planState.updateMany({
        where: { shop },
        data: { winbackSeenAt: new Date() },
    });
}