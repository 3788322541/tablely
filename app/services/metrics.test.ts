/**
 * 指标口径单测（M15 / §22）
 *
 * 这些断言就是 §22.1 表格的「可执行版本」：口径被钉死后，
 * `scripts/metrics.ts` 出数才不会因为分周 / 中位 / 分母选择漂移而误判。
 */
import { describe, expect, it } from "vitest";

import {
    activationFunnel,
    applicationStats,
    averageRowsPerSubmission,
    blockAddedWithoutAddToCart,
    median,
    medianWeeklySubmissionsPerShop,
    monetizationSnapshot,
    percent,
    retentionAtDays,
    startOfIsoWeek,
    toIsoDate,
    weeklyActiveShops,
    type AddToCartRow,
    type ShopActivationRow,
} from "./metrics.server";

const NOW = new Date("2026-10-06T12:00:00.000Z"); // 周二
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("通用小工具", () => {
    it("median：奇数取中位、偶数取均值、空数组为 null", () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([1, 2, 3, 4])).toBe(2.5);
        expect(median([])).toBeNull();
    });

    it("percent：分母为 0 返回 null（不把「无数据」当 0%）", () => {
        expect(percent(1, 4)).toBe(25);
        expect(percent(1, 3)).toBe(33.3);
        expect(percent(0, 0)).toBeNull();
    });

    it("startOfIsoWeek：按 UTC 归到周一", () => {
        // 2024-01-03 是周三 → 该 ISO 周起始为 2024-01-01（周一）
        expect(toIsoDate(startOfIsoWeek(day("2024-01-03")))).toBe("2024-01-01");
        // 周日属于上一周
        expect(toIsoDate(startOfIsoWeek(day("2026-10-11")))).toBe("2026-10-05");
    });
});

describe("激活漏斗（§22.1 激活层）", () => {
    const shops: ShopActivationRow[] = [
        {
            shop: "a.myshopify.com",
            createdAt: day("2026-09-01"),
            blockAddedAt: day("2026-09-01"),
            firstProductAt: day("2026-09-02"),
            // 安装 12h 后首次加购
            firstAddToCart: new Date("2026-09-01T12:00:00.000Z"),
        },
        {
            shop: "b.myshopify.com",
            createdAt: day("2026-09-01"),
            blockAddedAt: day("2026-09-03"),
            firstProductAt: null,
            firstAddToCart: null,
        },
        {
            shop: "c.myshopify.com",
            createdAt: day("2026-09-01"),
            blockAddedAt: null,
            firstProductAt: null,
            firstAddToCart: null,
        },
        {
            shop: "d.myshopify.com",
            createdAt: day("2026-09-01"),
            blockAddedAt: day("2026-09-02"),
            firstProductAt: day("2026-09-02"),
            // 安装 36h 后首次加购（超过 24h 目标，但中位仍应 ≤ 24h）
            firstAddToCart: new Date("2026-09-02T12:00:00.000Z"),
        },
    ];

    it("逐级计数与占比正确", () => {
        const funnel = activationFunnel(shops);
        expect(funnel.installed).toBe(4);
        expect(funnel.blockAdded).toBe(3);
        expect(funnel.firstProduct).toBe(2);
        expect(funnel.firstAddToCart).toBe(2);
        expect(funnel.blockAddedRate).toBe(75);
        expect(funnel.firstProductRate).toBe(50);
        expect(funnel.firstAddToCartRate).toBe(50);
    });

    it("中位激活时长取「安装 → 首次加购」小时数的中位（≤24h 目标）", () => {
        expect(activationFunnel(shops).medianHoursToFirstAddToCart).toBe(24);
    });

    it("无任何激活时中位时长为 null，占比为 null 而非 0", () => {
        const funnel = activationFunnel([]);
        expect(funnel.medianHoursToFirstAddToCart).toBeNull();
        expect(funnel.firstAddToCartRate).toBeNull();
    });
});

describe("使用层（§22.1 北极星 WAS）", () => {
    const events: AddToCartRow[] = [
        // 本周（2026-10-05 起）：两家店
        { shop: "a", rows: 3, quantity: 10, createdAt: day("2026-10-06") },
        { shop: "a", rows: 5, quantity: 20, createdAt: day("2026-10-06") },
        { shop: "b", rows: 2, quantity: 4, createdAt: day("2026-10-07") },
        // 上一周（2026-09-28 起）：一家店
        { shop: "a", rows: 4, quantity: 8, createdAt: day("2026-09-29") },
        // 更早：只有一次提交的「试玩」店铺 c
        { shop: "c", rows: 1, quantity: 1, createdAt: day("2026-08-01") },
    ];

    it("按 ISO 周分桶、同店同周只计一次", () => {
        const weeks = weeklyActiveShops(events, { weeks: 3, now: NOW });
        expect(weeks.map((week) => week.weekStart)).toEqual([
            "2026-09-21",
            "2026-09-28",
            "2026-10-05",
        ]);
        expect(weeks.map((week) => week.activeShops)).toEqual([0, 1, 2]);
    });

    it("每店周提交数中位：剔除单次试玩店铺后再取中位", () => {
        // a 店：本周 2 次 + 上周 1 次 → 2 个活跃周、共 3 次 → 1.5
        // c 店只有 1 次 → 剔除；b 店 1 次 → 剔除
        expect(
            medianWeeklySubmissionsPerShop(events, { weeks: 4, now: NOW }),
        ).toBe(1.5);
    });

    it("平均每单行数（§22.1 目标 ≥ 3 行）", () => {
        expect(averageRowsPerSubmission(events)).toBe(3);
    });

    it("没有任何事件时两个指标均为 null", () => {
        expect(averageRowsPerSubmission([])).toBeNull();
        expect(
            medianWeeklySubmissionsPerShop([], { weeks: 4, now: NOW }),
        ).toBeNull();
    });
});

describe("留存（§22.1 留存层）", () => {
    const shops: ShopActivationRow[] = [
        {
            shop: "old",
            createdAt: day("2026-05-01"),
            blockAddedAt: null,
            firstProductAt: null,
            firstAddToCart: day("2026-05-01"),
        },
        {
            shop: "recent",
            createdAt: day("2026-10-01"),
            blockAddedAt: null,
            firstProductAt: null,
            firstAddToCart: day("2026-10-01"),
        },
    ];
    // old 在第 90 天当周仍有加购；recent 观察期未满
    const events: AddToCartRow[] = [
        { shop: "old", rows: 2, quantity: 2, createdAt: day("2026-07-30") },
    ];

    it("90 天留存：未满观察期的店铺不进分母", () => {
        const result = retentionAtDays(shops, events, { days: 90, now: NOW });
        expect(result.cohort).toBe(1);
        expect(result.retained).toBe(1);
        expect(result.rate).toBe(100);
    });

    it("4 周留存：窗口内无提交则不保留", () => {
        const result = retentionAtDays(shops, events, { days: 28, now: NOW });
        expect(result.retained).toBe(0);
        expect(result.rate).toBe(0);
    });
});

describe("变现与反指标（§22.1 变现层 / §22.2）", () => {
    it("试用 → 付费转化与降级快照", () => {
        const snapshot = monetizationSnapshot([
            { shop: "a", plan: "pro", trialEndsAt: day("2026-08-01"), everPro: true, winbackSeenAt: null },
            { shop: "b", plan: "free", trialEndsAt: day("2026-08-01"), everPro: true, winbackSeenAt: day("2026-09-01") },
            { shop: "c", plan: "free", trialEndsAt: null, everPro: false, winbackSeenAt: null },
            { shop: "d", plan: "pro", trialEndsAt: day("2026-09-01"), everPro: true, winbackSeenAt: day("2026-09-20") },
        ]);

        expect(snapshot.trialStarted).toBe(3);
        expect(snapshot.activePro).toBe(2);
        expect(snapshot.trialToPaidRate).toBe(66.7);
        expect(snapshot.downgradedNow).toBe(1);
        expect(snapshot.winbackReturned).toBe(1);
    });

    it("反指标④：已加 App Block 但从未加购的店铺数", () => {
        expect(
            blockAddedWithoutAddToCart([
                { shop: "a", createdAt: day("2026-09-01"), blockAddedAt: day("2026-09-01"), firstProductAt: null, firstAddToCart: null },
                { shop: "b", createdAt: day("2026-09-01"), blockAddedAt: day("2026-09-01"), firstProductAt: null, firstAddToCart: day("2026-09-02") },
                { shop: "c", createdAt: day("2026-09-01"), blockAddedAt: null, firstProductAt: null, firstAddToCart: null },
            ]),
        ).toBe(1);
    });
});

describe("申请表单运营效果（§22.3）", () => {
    it("通过率分母只算已裁决（pending 不拉低通过率）", () => {
        const stats = applicationStats([
            { shop: "a", status: "approved" },
            { shop: "a", status: "rejected" },
            { shop: "a", status: "pending" },
        ]);
        expect(stats.total).toBe(3);
        expect(stats.pending).toBe(1);
        expect(stats.approvalRate).toBe(50);
    });

    it("全部 pending 时通过率为 null", () => {
        expect(applicationStats([{ shop: "a", status: "pending" }]).approvalRate).toBeNull();
    });
});
