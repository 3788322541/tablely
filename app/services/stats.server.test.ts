/**
 * 加购统计单测（M14 / §1.4 #26 / §22.1）
 *
 * 覆盖：窗口区间按店铺时区对齐、单次查询 + 内存切片（今日 / 近 7 天 / 近 30 天）、
 * 提交归组口径（`(customerId, 秒, rows)`）、Top 变体跨商品汇总与展示名解析兜底。
 *
 * 口径红线：**纯加购指标**，不含转化率、不读订单。
 *
 * 放在 `services/`：`app/routes/` 下的 `.test.ts` 会被 flat routes 当成路由模块。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("../db.server", () => ({
    default: { addToCartEvent: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

vi.mock("./monitor.server", () => ({ logStructured: vi.fn() }));

import {
    formatVariantLabel,
    loadAddToCartStats,
    resolveVariantLabels,
    windowRange,
} from "./stats.server";

type EventRow = {
    variantId: string;
    quantity: number;
    rows: number;
    customerId: string | null;
    createdAt: Date;
};

const event = (
    createdAt: string,
    variantId: string,
    quantity: number,
    rows: number,
    customerId: string | null,
): EventRow => ({ variantId, quantity, rows, customerId, createdAt: new Date(createdAt) });

beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
});

describe("windowRange（按店铺时区对齐）", () => {
    const now = new Date("2026-06-15T10:00:00Z");

    it("UTC：今日 / 近 7 天 / 近 30 天", () => {
        expect(windowRange("today", "UTC", now).start.toISOString()).toBe(
            "2026-06-15T00:00:00.000Z",
        );
        expect(windowRange("7d", "UTC", now).start.toISOString()).toBe(
            "2026-06-09T00:00:00.000Z",
        );
        expect(windowRange("30d", "UTC", now).start.toISOString()).toBe(
            "2026-05-17T00:00:00.000Z",
        );
        // 上界恒为「次日 00:00」（半开区间）
        expect(windowRange("today", "UTC", now).end.toISOString()).toBe(
            "2026-06-16T00:00:00.000Z",
        );
    });

    it("上海（UTC+8）：区间整体平移", () => {
        const range = windowRange("today", "Asia/Shanghai", now);
        expect(range.start.toISOString()).toBe("2026-06-14T16:00:00.000Z");
        expect(range.end.toISOString()).toBe("2026-06-15T16:00:00.000Z");
    });
});

describe("loadAddToCartStats（聚合与切片）", () => {
    const now = new Date("2026-06-15T12:00:00Z");

    const load = () =>
        loadAddToCartStats({ shop: "s.myshopify.com", timezone: "UTC", now });

    it("查询以最宽（30 天）窗口一次取数，且恒带 shop", async () => {
        await load();
        const args = findMany.mock.calls[0][0] as {
            where: { shop: string; createdAt: { gte: Date; lt: Date } };
        };
        expect(args.where.shop).toBe("s.myshopify.com");
        expect(args.where.createdAt.gte.toISOString()).toBe("2026-05-17T00:00:00.000Z");
        expect(args.where.createdAt.lt.toISOString()).toBe("2026-06-16T00:00:00.000Z");
    });

    it("三段窗口切片 + 提交归组 + 平均每单行数", async () => {
        findMany.mockResolvedValue([
            // 今日：同一客户、同一秒、同行数 → 归为同一次提交
            event("2026-06-15T08:00:00Z", "111", 3, 2, "9"),
            event("2026-06-15T08:00:00Z", "222", 1, 2, "9"),
            // 近 7 天内、非今日
            event("2026-06-10T08:00:00Z", "111", 5, 1, null),
            // 仅近 30 天窗口内
            event("2026-05-20T08:00:00Z", "333", 2, 1, "7"),
        ]);

        const { totals } = await load();

        expect(totals.today).toEqual({
            rows: 2,
            units: 4,
            submissions: 1,
            avgRowsPerOrder: 2,
        });
        expect(totals["7d"]).toEqual({
            rows: 3,
            units: 9,
            submissions: 2,
            avgRowsPerOrder: 1.5,
        });
        expect(totals["30d"]).toEqual({
            rows: 4,
            units: 11,
            submissions: 3,
            avgRowsPerOrder: 1.3,
        });
    });

    it("Top 变体跨商品汇总、按件数降序、上限 5", async () => {
        findMany.mockResolvedValue([
            event("2026-06-15T08:00:00Z", "111", 3, 1, "9"),
            event("2026-06-15T08:00:01Z", "111", 5, 1, "9"),
            event("2026-06-15T08:00:02Z", "222", 1, 1, "9"),
            event("2026-06-15T08:00:03Z", "333", 9, 1, "9"),
        ]);

        const { topVariants } = await load();
        expect(topVariants.map((item) => [item.variantId, item.units])).toEqual([
            ["333", 9],
            ["111", 8],
            ["222", 1],
        ]);
    });

    it("无 admin 时展示名保持 null（页面退回 #id）", async () => {
        findMany.mockResolvedValue([event("2026-06-15T08:00:00Z", "111", 3, 1, "9")]);
        const { topVariants } = await load();
        expect(topVariants[0].label).toBeNull();
    });

    it("传 admin 时解析展示名；解析失败不影响数字", async () => {
        findMany.mockResolvedValue([event("2026-06-15T08:00:00Z", "111", 3, 1, "9")]);
        const admin = {
            graphql: vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        data: {
                            nodes: [
                                {
                                    id: "gid://shopify/ProductVariant/111",
                                    title: "Default Title",
                                    sku: "SKU-1",
                                    product: { title: "Widget" },
                                },
                            ],
                        },
                    }),
                ),
            ),
        };

        const { topVariants } = await loadAddToCartStats({
            shop: "s.myshopify.com",
            timezone: "UTC",
            now,
            admin,
        });
        expect(topVariants[0]).toEqual({ variantId: "111", units: 3, label: "Widget" });
    });

    it("空数据 → 三段皆为 0，Top 变体为空", async () => {
        const { totals, topVariants } = await load();
        expect(topVariants).toEqual([]);
        for (const key of ["today", "7d", "30d"] as const) {
            expect(totals[key]).toEqual({
                rows: 0,
                units: 0,
                submissions: 0,
                avgRowsPerOrder: 0,
            });
        }
    });
});

describe("formatVariantLabel", () => {
    it("商品名 + 变体名", () => {
        expect(
            formatVariantLabel({
                id: "gid://shopify/ProductVariant/1",
                title: "Large",
                product: { title: "Tee" },
            }),
        ).toBe("Tee · Large");
    });

    it("变体为 Default Title 时只留商品名", () => {
        expect(
            formatVariantLabel({
                id: "gid://shopify/ProductVariant/1",
                title: "Default Title",
                product: { title: "Tee" },
            }),
        ).toBe("Tee");
    });

    it("无商品名退回 SKU；都无则 null", () => {
        expect(formatVariantLabel({ id: "1", title: "", sku: "SKU-9" })).toBe("SKU-9");
        expect(formatVariantLabel({ id: "1", title: "", sku: "" })).toBeNull();
    });
});

describe("resolveVariantLabels", () => {
    it("非数字 id 被过滤；空集合不查 Admin API", async () => {
        const graphql = vi.fn();
        const map = await resolveVariantLabels({ graphql }, ["abc", ""]);
        expect(graphql).not.toHaveBeenCalled();
        expect(map.size).toBe(0);
    });

    it("Admin API 抛错 → 空 Map（不影响数字）", async () => {
        const graphql = vi.fn().mockRejectedValue(new Error("boom"));
        const map = await resolveVariantLabels({ graphql }, ["111"]);
        expect(map.size).toBe(0);
    });
});
