/**
 * Billing / 档位 / 挽回单测（M9，方案 §七 / §19）
 *
 * 用**假 Prisma + 假 Admin**验证订阅编排，不连真库、不发真请求：
 *   · 档位回写（ACTIVE/TRIALING→pro，其余→free；everPro 只升不降）；
 *   · 折扣同步**复用不创建**（只对 DiscountState 已登记 id 调启停，绝不 create）；
 *   · 挽回计数（超限只读数 / 暂停折扣数 / 被锁功能数 / 只提示一次）；
 *   · 试用将尽窗口（剩余 1–2 天）。
 *
 * 真实「创建订阅 → 批准 → 折扣真正下线/恢复」需在线 Admin，属 M15 提审前复核项。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        planState: {
            findUnique: vi.fn(),
            upsert: vi.fn(),
            updateMany: vi.fn(),
        },
        discountState: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        productTable: {
            count: vi.fn(),
            findMany: vi.fn(),
        },
        layoutTemplate: { count: vi.fn() },
        shopSettings: { findUnique: vi.fn() },
    },
}));

vi.mock("../db.server", () => ({ default: prismaMock }));

import {
    applySubscriptionWebhook,
    createSubscription,
    getWinbackSummary,
    isActiveStatus,
    readPlanStatus,
    syncDiscountsForPlan,
    syncPlanFromShopify,
} from "./billing.server";
import type { GraphqlAdmin } from "./metafield.server";

const SHOP = "tablely-dev.myshopify.com";

const response = (body: unknown): Response =>
    ({ json: async () => body }) as unknown as Response;

/** 每次 graphql 调用返回同一份 payload（够用；折扣 mutation 视作成功） */
function fakeAdmin(payload: unknown): GraphqlAdmin {
    return { graphql: vi.fn(async () => response(payload)) } as unknown as GraphqlAdmin;
}

/** 订阅查询的成功 payload */
const subscriptionPayload = (sub: unknown) => ({
    data: { currentAppInstallation: { activeSubscriptions: sub ? [sub] : [] } },
});

beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.planState.findUnique.mockResolvedValue(null);
    prismaMock.planState.upsert.mockResolvedValue({});
    prismaMock.planState.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.discountState.findUnique.mockResolvedValue(null);
    prismaMock.discountState.update.mockResolvedValue({});
    prismaMock.productTable.count.mockResolvedValue(0);
    prismaMock.productTable.findMany.mockResolvedValue([]);
    prismaMock.layoutTemplate.count.mockResolvedValue(0);
    prismaMock.shopSettings.findUnique.mockResolvedValue(null);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("isActiveStatus", () => {
    it("ACTIVE / TRIALING（大小写不敏感）算有效", () => {
        expect(isActiveStatus("ACTIVE")).toBe(true);
        expect(isActiveStatus("trialing")).toBe(true);
    });

    it("其余状态不算 Pro", () => {
        for (const status of ["CANCELLED", "EXPIRED", "DECLINED", "FROZEN", "", "PENDING"]) {
            expect(isActiveStatus(status)).toBe(false);
        }
    });
});

describe("syncDiscountsForPlan（复用不创建）", () => {
    it("无 DiscountState 记录 → no-op，不写库", async () => {
        const admin = fakeAdmin({});
        const result = await syncDiscountsForPlan(admin, SHOP, "pro");
        expect(result).toEqual({ ids: 0, updated: 0 });
        expect(prismaMock.discountState.update).not.toHaveBeenCalled();
        expect(admin.graphql).not.toHaveBeenCalled();
    });

    it("记录存在但无 id → no-op", async () => {
        prismaMock.discountState.findUnique.mockResolvedValue({
            shop: SHOP,
            tierDiscountId: null,
            wholeDiscountId: null,
            mixMatchDiscountId: null,
            active: true,
        });
        const admin = fakeAdmin({});
        const result = await syncDiscountsForPlan(admin, SHOP, "free");
        expect(result).toEqual({ ids: 0, updated: 0 });
        expect(admin.graphql).not.toHaveBeenCalled();
    });

    it("Pro → 对已登记 3 个 id 逐个 activate，并写回 active=true", async () => {
        prismaMock.discountState.findUnique.mockResolvedValue({
            shop: SHOP,
            tierDiscountId: "gid://Discount/1",
            wholeDiscountId: "gid://Discount/2",
            mixMatchDiscountId: "gid://Discount/3",
            active: false,
        });
        const admin = fakeAdmin({ data: { discountAutomaticActivate: { userErrors: [] } } });
        const result = await syncDiscountsForPlan(admin, SHOP, "pro");
        expect(result).toEqual({ ids: 3, updated: 3 });
        expect(prismaMock.discountState.update).toHaveBeenCalledWith({
            where: { shop: SHOP },
            data: { active: true, syncedAt: expect.any(Date) },
        });
        // 只调启停 mutation，绝不创建折扣
        const queries = (admin.graphql as ReturnType<typeof vi.fn>).mock.calls.map(
            (call) => String(call[0]),
        );
        expect(queries.every((query) => query.includes("discountAutomaticActivate"))).toBe(
            true,
        );
        expect(queries.some((query) => /Create/i.test(query))).toBe(false);
    });

    it("Free → 对已登记 id 逐个 deactivate，并写回 active=false", async () => {
        prismaMock.discountState.findUnique.mockResolvedValue({
            shop: SHOP,
            tierDiscountId: "gid://Discount/1",
            wholeDiscountId: "gid://Discount/2",
            mixMatchDiscountId: null,
            active: true,
        });
        const admin = fakeAdmin({ data: { discountAutomaticDeactivate: { userErrors: [] } } });
        const result = await syncDiscountsForPlan(admin, SHOP, "free");
        expect(result).toEqual({ ids: 2, updated: 2 });
        expect(prismaMock.discountState.update).toHaveBeenCalledWith({
            where: { shop: SHOP },
            data: { active: false, syncedAt: expect.any(Date) },
        });
    });

    it("单个 mutation 失败不中断其余：updated 只计成功数，仍写回标记", async () => {
        prismaMock.discountState.findUnique.mockResolvedValue({
            shop: SHOP,
            tierDiscountId: "gid://Discount/1",
            wholeDiscountId: "gid://Discount/2",
            mixMatchDiscountId: "gid://Discount/3",
            active: false,
        });
        const graphql = vi.fn(async (_q: string, vars?: { variables?: { id?: string } }) => {
            if (vars?.variables?.id === "gid://Discount/2") throw new Error("boom");
            return response({ data: { discountAutomaticActivate: { userErrors: [] } } });
        });
        const admin = { graphql } as unknown as GraphqlAdmin;
        const result = await syncDiscountsForPlan(admin, SHOP, "pro");
        expect(result).toEqual({ ids: 3, updated: 2 });
        expect(prismaMock.discountState.update).toHaveBeenCalled();
    });
});

describe("syncPlanFromShopify（权威值回写）", () => {
    it("有有效订阅（ACTIVE）→ plan=pro，新建时 everPro=true", async () => {
        const admin = fakeAdmin(
            subscriptionPayload({ id: "gid://Sub/1", status: "ACTIVE", trialDays: 7, currentPeriodEnd: null }),
        );
        const plan = await syncPlanFromShopify(admin, SHOP);
        expect(plan).toBe("pro");
        const arg = prismaMock.planState.upsert.mock.calls[0][0];
        expect(arg.create).toMatchObject({ shop: SHOP, plan: "pro", everPro: true });
        expect(arg.update).toMatchObject({ plan: "pro" });
    });

    it("无有效订阅 → plan=free", async () => {
        const admin = fakeAdmin(subscriptionPayload(null));
        const plan = await syncPlanFromShopify(admin, SHOP);
        expect(plan).toBe("free");
        expect(prismaMock.planState.upsert.mock.calls[0][0].create).toMatchObject({
            plan: "free",
            everPro: false,
        });
    });

    it("TRIALING → trialEndsAt 取 currentPeriodEnd", async () => {
        const end = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
        const admin = fakeAdmin(
            subscriptionPayload({ id: "gid://Sub/1", status: "TRIALING", trialDays: 7, currentPeriodEnd: end }),
        );
        await syncPlanFromShopify(admin, SHOP);
        const arg = prismaMock.planState.upsert.mock.calls[0][0];
        expect(arg.create.trialEndsAt).toEqual(new Date(end));
    });

    it("everPro 只升不降：已是 Pro，本次 free → update 不带 everPro=false", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "pro", everPro: true });
        const admin = fakeAdmin(subscriptionPayload(null));
        await syncPlanFromShopify(admin, SHOP);
        const arg = prismaMock.planState.upsert.mock.calls[0][0];
        expect(arg.update).not.toHaveProperty("everPro");
    });

    it("档位变化 free→pro 才触发折扣同步（读 DiscountState）", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", everPro: false });
        const admin = fakeAdmin(
            subscriptionPayload({ id: "gid://Sub/1", status: "ACTIVE", trialDays: 7, currentPeriodEnd: null }),
        );
        await syncPlanFromShopify(admin, SHOP);
        expect(prismaMock.discountState.findUnique).toHaveBeenCalled();
    });

    it("档位未变（pro→pro）不触发折扣同步", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "pro", everPro: true });
        const admin = fakeAdmin(
            subscriptionPayload({ id: "gid://Sub/1", status: "ACTIVE", trialDays: 7, currentPeriodEnd: null }),
        );
        await syncPlanFromShopify(admin, SHOP);
        expect(prismaMock.discountState.findUnique).not.toHaveBeenCalled();
    });
});

describe("applySubscriptionWebhook", () => {
    it("CANCELLED → free；缺 status 抛错", async () => {
        const plan = await applySubscriptionWebhook(SHOP, { app_subscription: { status: "CANCELLED" } });
        expect(plan).toBe("free");
        await expect(applySubscriptionWebhook(SHOP, {})).rejects.toThrow();
    });

    it("ACTIVE → pro，且 webhook 不改 trialEndsAt", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", everPro: false });
        await applySubscriptionWebhook(SHOP, { app_subscription: { status: "ACTIVE" } });
        const arg = prismaMock.planState.upsert.mock.calls[0][0];
        expect(arg.update).toMatchObject({ plan: "pro" });
        expect(arg.update).not.toHaveProperty("trialEndsAt");
    });
});

describe("readPlanStatus（试用将尽）", () => {
    const pro = (trialEndsAt: Date | null) => {
        prismaMock.planState.findUnique.mockResolvedValue({
            plan: "pro",
            trialEndsAt,
            everPro: true,
            winbackSeenAt: null,
        });
    };

    it("剩余 1.5 天 → trialDaysLeft=2，endingSoon=true", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
        pro(new Date("2026-10-05T12:00:00Z"));
        const status = await readPlanStatus(SHOP);
        expect(status.trialDaysLeft).toBe(2);
        expect(status.trialEndingSoon).toBe(true);
    });

    it("剩余 3 天 → endingSoon=false", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
        pro(new Date("2026-10-07T00:00:00Z"));
        const status = await readPlanStatus(SHOP);
        expect(status.trialDaysLeft).toBe(3);
        expect(status.trialEndingSoon).toBe(false);
    });

    it("已过期 → trialDaysLeft=0，endingSoon=false", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
        pro(new Date("2026-10-01T00:00:00Z"));
        const status = await readPlanStatus(SHOP);
        expect(status.trialDaysLeft).toBe(0);
        expect(status.trialEndingSoon).toBe(false);
    });

    it("Free（无 trialEndsAt）→ trialDaysLeft=null", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({
            plan: "free",
            trialEndsAt: null,
            everPro: false,
            winbackSeenAt: null,
        });
        const status = await readPlanStatus(SHOP);
        expect(status.trialDaysLeft).toBeNull();
        expect(status.trialEndingSoon).toBe(false);
    });
});

describe("getWinbackSummary（真实数字）", () => {
    it("plan=pro → 全 0", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "pro", trialEndsAt: null, everPro: true, winbackSeenAt: null });
        const summary = await getWinbackSummary(SHOP);
        expect(summary).toEqual({
            discountsPaused: 0,
            productsReadOnly: 0,
            featuresLocked: 0,
            showSummary: false,
        });
    });

    it("Free 超限：12 启用 → productsReadOnly=9", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", trialEndsAt: null, everPro: true, winbackSeenAt: new Date() });
        prismaMock.productTable.count.mockResolvedValue(12);
        const summary = await getWinbackSummary(SHOP);
        expect(summary.productsReadOnly).toBe(9);
    });

    it("Free：折扣被暂停时按已登记 id 数计数", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", trialEndsAt: null, everPro: true, winbackSeenAt: new Date() });
        prismaMock.discountState.findUnique.mockResolvedValue({
            shop: SHOP,
            tierDiscountId: "gid://Discount/1",
            wholeDiscountId: "gid://Discount/2",
            mixMatchDiscountId: "gid://Discount/3",
            active: false,
        });
        const summary = await getWinbackSummary(SHOP);
        expect(summary.discountsPaused).toBe(3);
    });

    it("Free：模板 + 起订金额 + 非灰缺货 + 自定义样式 → featuresLocked 累加", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", trialEndsAt: null, everPro: true, winbackSeenAt: new Date() });
        prismaMock.layoutTemplate.count.mockResolvedValue(2);
        prismaMock.shopSettings.findUnique.mockResolvedValue({
            orderMinAmount: "50.00",
            theme: { brandColor: "#000000", density: "default", font: "inherit" },
            outOfStockMode: "hide",
        });
        prismaMock.productTable.findMany.mockResolvedValue([
            { layout: null, orderMinAmount: "10.00" },
            { layout: "grid", orderMinAmount: null },
        ]);
        const summary = await getWinbackSummary(SHOP);
        // 模板2 + 店铺起订1 + 非灰缺货1 + 样式1 + 商品级起订1 = 6
        expect(summary.featuresLocked).toBe(6);
    });

    it("showSummary：everPro 且从未关闭 → true；已关闭 → false", async () => {
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", trialEndsAt: null, everPro: true, winbackSeenAt: null });
        expect((await getWinbackSummary(SHOP)).showSummary).toBe(true);
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", trialEndsAt: null, everPro: true, winbackSeenAt: new Date() });
        expect((await getWinbackSummary(SHOP)).showSummary).toBe(false);
        prismaMock.planState.findUnique.mockResolvedValue({ plan: "free", trialEndsAt: null, everPro: false, winbackSeenAt: null });
        expect((await getWinbackSummary(SHOP)).showSummary).toBe(false);
    });
});

describe("createSubscription", () => {
    it("成功 → 返回 confirmationUrl", async () => {
        const admin = fakeAdmin({
            data: { appSubscriptionCreate: { confirmationUrl: "https://shopify.com/confirm/1", userErrors: [] } },
        });
        const url = await createSubscription(admin, {
            planKey: "pro_monthly",
            returnUrl: "https://admin.shopify.com/store/x/apps/y/app/plans",
            test: true,
        });
        expect(url).toBe("https://shopify.com/confirm/1");
    });

    it("userErrors 非空 → 抛错", async () => {
        const admin = fakeAdmin({
            data: { appSubscriptionCreate: { userErrors: [{ message: "bad" }] } },
        });
        await expect(
            createSubscription(admin, { planKey: "pro_annual", returnUrl: "https://x", test: true }),
        ).rejects.toThrow("bad");
    });
});