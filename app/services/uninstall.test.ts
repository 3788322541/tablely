/**
 * 卸载 / shop_redact 清理单测（M8，§2.2.2 / §8.1 / §十二 验收 10、23）
 *
 * `cleanupShopData` 的编排逻辑（先读 → 清 Shopify 侧 → 清 DB）用**假 Prisma + 假 Admin**
 * 验证，不连真库、不发真请求：
 *   · **无 admin**（token 已吊销 / shop_redact）：跳过 Shopify 侧、只清 DB，且不报错；
 *   · **有 admin 且删除失败**：逐个捕获失败、计数、**绝不抛错**（否则 webhook 500 触发无限重试）；
 *   · **DB 清理**：15 张业务表**全部按 shop 条件**删除（租户隔离 §8.2 A）。
 *
 * 真实「删折扣 + 删 metafield 落库生效」需在线 Admin API，属 M15 提审前复核项。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => {
    const del = () => vi.fn().mockResolvedValue({ count: 0 });
    return {
        prismaMock: {
            addToCartEvent: { deleteMany: del() },
            customerGroup: { deleteMany: del() },
            discountState: {
                findUnique: vi.fn().mockResolvedValue(null),
                deleteMany: del(),
            },
            layoutTemplate: { deleteMany: del() },
            mixMatchGroup: { deleteMany: del() },
            mixMatchMember: { deleteMany: del() },
            planState: { deleteMany: del() },
            productTable: {
                findMany: vi.fn().mockResolvedValue([]),
                deleteMany: del(),
            },
            quote: { deleteMany: del() },
            session: { deleteMany: del() },
            shopSettings: { deleteMany: del() },
            variantRule: { deleteMany: del() },
            webhookEvent: { deleteMany: del() },
            wholesaleApplication: { deleteMany: del() },
            wholesalePrice: { deleteMany: del() },
        },
    };
});

vi.mock("../db.server", () => ({ default: prismaMock }));

import { cleanupShopData } from "./uninstall.server";
import type { GraphqlAdmin } from "./metafield.server";

const SHOP = "tablely-dev.myshopify.com";

const jsonResponse = (body: unknown): Response =>
    ({ json: async () => body }) as unknown as Response;

/** 按 query 内容分派的假 Admin（`TablelyShop` 查询 / `DeleteDiscount` / `DeleteMetafields`） */
function fakeAdmin(handlers: {
    shop?: () => unknown;
    discount?: () => unknown;
    metafields?: () => unknown;
}): GraphqlAdmin {
    return {
        graphql: vi.fn(async (query: string) => {
            if (query.includes("TablelyShop")) {
                return jsonResponse(
                    handlers.shop?.() ?? {
                        data: { shop: { id: "gid://shopify/Shop/1", currencyCode: "USD" } },
                    },
                );
            }
            if (query.includes("TablelyDeleteDiscount")) {
                return jsonResponse(
                    handlers.discount?.() ?? {
                        data: { discountAutomaticDelete: { userErrors: [] } },
                    },
                );
            }
            return jsonResponse(
                handlers.metafields?.() ?? {
                    data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } },
                },
            );
        }),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.discountState.findUnique.mockResolvedValue(null);
    prismaMock.productTable.findMany.mockResolvedValue([]);
});

describe("无 admin（token 已吊销 / shop_redact）", () => {
    it("跳过 Shopify 侧、只清 DB，且不报错", async () => {
        prismaMock.discountState.findUnique.mockResolvedValue({
            tierDiscountId: "gid://shopify/DiscountAutomaticNode/1",
            wholeDiscountId: null,
            mixMatchDiscountId: "gid://shopify/DiscountAutomaticNode/3",
        });
        prismaMock.productTable.findMany.mockResolvedValue([
            { productId: "gid://shopify/Product/1" },
            { productId: "gid://shopify/Product/2" },
        ]);

        const result = await cleanupShopData({ shop: SHOP });

        expect(result).toEqual({
            discountsAttempted: 2,
            metafieldsAttempted: 3, // Shop 级 1 + 商品级 2
            shopifyFailures: 0,
            tablesPurged: 15,
        });
        // 15 张表全部按 shop 条件清理
        for (const model of Object.values(prismaMock)) {
            if ("deleteMany" in model) {
                expect(model.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
            }
        }
    });
});

describe("有 admin：Shopify 侧删除失败也必须吞掉（best effort）", () => {
    it("折扣删除报错 → 计数失败但不抛错，metafield 继续删", async () => {
        prismaMock.discountState.findUnique.mockResolvedValue({
            tierDiscountId: "gid://shopify/DiscountAutomaticNode/1",
            wholeDiscountId: "gid://shopify/DiscountAutomaticNode/2",
            mixMatchDiscountId: null,
        });
        prismaMock.productTable.findMany.mockResolvedValue([
            { productId: "gid://shopify/Product/1" },
        ]);

        const admin = fakeAdmin({
            discount: () => ({ errors: [{ message: "Access denied (token revoked)" }] }),
        });

        const result = await cleanupShopData({ shop: SHOP, admin });

        expect(result.discountsAttempted).toBe(2);
        expect(result.shopifyFailures).toBe(2); // 两个折扣都失败
        expect(result.metafieldsAttempted).toBe(2); // Shop 级 1 + 商品级 1（仍继续）
        expect(result.tablesPurged).toBe(15);
    });

    it("取不到 Shop GID → 只跳过 Shop 级 metafield，商品级仍尝试", async () => {
        prismaMock.productTable.findMany.mockResolvedValue([
            { productId: "gid://shopify/Product/1" },
            { productId: "gid://shopify/Product/2" },
        ]);

        const admin = fakeAdmin({
            shop: () => ({ errors: [{ message: "token revoked" }] }),
        });

        const result = await cleanupShopData({ shop: SHOP, admin });

        expect(result.discountsAttempted).toBe(0);
        expect(result.metafieldsAttempted).toBe(2); // 仅两个商品级
        expect(result.shopifyFailures).toBe(1); // Shop 级那一次
        expect(result.tablesPurged).toBe(15);
    });
});
