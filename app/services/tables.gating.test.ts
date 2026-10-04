/**
 * Pro 门控 / 降级只读 后端拒写单测（M9，方案 §1.6 / §19.3）
 *
 * 用假 Prisma 验证「后端双保险」——即使前端被绕过，Free 也写不进 Pro 字段：
 *   · 店铺级起订金额（#36）Free → error.proRequired；
 *   · 商品级：非 table 布局（#3）/ 起订金额  Free → error.proRequired；
 *   · 降级超限商品（已启用且超出 Free 额度）→ error.overLimitReadOnly；
 *   · 只读口径（listReadOnlyProductIds）按已启用行顺序取前 limit 个为额度内。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        planState: { findUnique: vi.fn() },
        productTable: { findUnique: vi.fn(), findMany: vi.fn() },
        shopSettings: { upsert: vi.fn() },
        variantRule: { deleteMany: vi.fn(), createMany: vi.fn() },
        $transaction: vi.fn(),
    },
}));

vi.mock("../db.server", () => ({ default: prismaMock }));

import { hasFeature } from "../plan";
import {
    FREE_PRODUCT_LIMIT,
    TablelyError,
    isProductReadOnly,
    isTablelyError,
    listReadOnlyProductIds,
    saveProductTable,
    saveShopOrderMinAmount,
} from "./tables.server";
import type { GraphqlAdmin } from "./metafield.server";

const SHOP = "tablely-dev.myshopify.com";
const PRODUCT = "gid://shopify/Product/1";

const free = () => prismaMock.planState.findUnique.mockResolvedValue({ plan: "free" });
const pro = () => prismaMock.planState.findUnique.mockResolvedValue({ plan: "pro" });
const noPlan = () => prismaMock.planState.findUnique.mockResolvedValue(null);

const expectKey = async (run: () => Promise<unknown>, key: string) => {
    try {
        await run();
        throw new Error(`应当抛错 ${key}`);
    } catch (error) {
        expect(isTablelyError(error)).toBe(true);
        expect((error as TablelyError).key).toBe(key);
    }
};

const dummyAdmin = {
    graphql: vi.fn(async () => ({
        json: async () => ({ data: { product: { variants: { nodes: [] } } } }),
    })),
} as unknown as GraphqlAdmin;

beforeEach(() => {
    vi.clearAllMocks();
    noPlan();
    prismaMock.productTable.findUnique.mockResolvedValue(null);
    prismaMock.productTable.findMany.mockResolvedValue([]);
    prismaMock.shopSettings.upsert.mockResolvedValue({});
});

describe("hasFeature 快速校验（Free 全 false / Pro 全 true）", () => {
    it("Free 不具备 order_minimum / layout_non_table", () => {
        expect(hasFeature("free", "order_minimum")).toBe(false);
        expect(hasFeature("free", "layout_non_table")).toBe(false);
    });
    it("Pro 具备", () => {
        expect(hasFeature("pro", "order_minimum")).toBe(true);
        expect(hasFeature("pro", "layout_non_table")).toBe(true);
    });
});

describe("saveShopOrderMinAmount（#36 店铺级起订金额）", () => {
    it("Free → error.proRequired，不写库", async () => {
        free();
        await expectKey(() => saveShopOrderMinAmount(SHOP, "50"), "error.proRequired");
        expect(prismaMock.shopSettings.upsert).not.toHaveBeenCalled();
    });

    it("Pro → 归一化后写库", async () => {
        pro();
        const value = await saveShopOrderMinAmount(SHOP, "12.5");
        expect(value).toBe("12.50");
        expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith({
            where: { shop: SHOP },
            update: { orderMinAmount: "12.50" },
            create: { shop: SHOP, orderMinAmount: "12.50" },
        });
    });
});

describe("saveProductTable 门控拒写", () => {
    const base = {
        admin: dummyAdmin,
        shop: SHOP,
        productId: PRODUCT,
        enabled: false,
        rules: [],
    };

    it("Free + 非 table 布局（grid）→ error.proRequired", async () => {
        free();
        await expectKey(
            () => saveProductTable({ ...base, layout: "grid", orderMinAmount: "" }),
            "error.proRequired",
        );
    });

    it("Free + 商品级起订金额 → error.proRequired", async () => {
        free();
        await expectKey(
            () => saveProductTable({ ...base, layout: null, orderMinAmount: "10" }),
            "error.proRequired",
        );
    });

    it("降级超限商品（已启用且超限）保存 → error.overLimitReadOnly", async () => {
        free();
        prismaMock.productTable.findUnique.mockResolvedValue({ enabled: true });
        // 启用 5 行（> FREE_PRODUCT_LIMIT=3），当前商品排在第 5（只读区）
        prismaMock.productTable.findMany.mockResolvedValue(
            [1, 2, 3, 4].map((n) => ({ productId: `gid://shopify/Product/${n}` })).concat([
                { productId: PRODUCT },
            ]),
        );
        await expectKey(
            () => saveProductTable({ ...base, enabled: true, layout: null, orderMinAmount: "" }),
            "error.overLimitReadOnly",
        );
    });
});

describe("listReadOnlyProductIds / isProductReadOnly（只读口径）", () => {
    const rows = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ productId: `gid://shopify/Product/${i + 1}` }));

    it("Pro → 空集合（不限制）", async () => {
        pro();
        expect(await listReadOnlyProductIds(SHOP)).toEqual(new Set());
        expect(prismaMock.productTable.findMany).not.toHaveBeenCalled();
    });

    it("Free 未超额（≤ limit）→ 空集合", async () => {
        free();
        prismaMock.productTable.findMany.mockResolvedValue(rows(FREE_PRODUCT_LIMIT));
        expect(await listReadOnlyProductIds(SHOP)).toEqual(new Set());
    });

    it("Free 超额 → 前 limit 个额度内，其余只读", async () => {
        free();
        prismaMock.productTable.findMany.mockResolvedValue(rows(5));
        const readOnly = await listReadOnlyProductIds(SHOP);
        expect(readOnly.size).toBe(5 - FREE_PRODUCT_LIMIT);
        expect(readOnly.has("gid://shopify/Product/4")).toBe(true);
        expect(readOnly.has("gid://shopify/Product/5")).toBe(true);
        expect(readOnly.has("gid://shopify/Product/3")).toBe(false);
    });

    it("isProductReadOnly：单商品查询命中只读区", async () => {
        free();
        prismaMock.productTable.findMany.mockResolvedValue(rows(5));
        expect(await isProductReadOnly(SHOP, "gid://shopify/Product/5")).toBe(true);
        expect(await isProductReadOnly(SHOP, "gid://shopify/Product/1")).toBe(false);
    });
});