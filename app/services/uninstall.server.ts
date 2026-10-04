/**
 * 卸载 / 数据删除清理（M8，§2.2.2 / §8.1 / §十二 验收 10）
 *
 * 应用被卸载时要做三件事，顺序不能反：
 *   ① **先读**：从 DB 取出「删折扣 / 删 metafield 需要的标识」——
 *      3 个 automatic discount 的 GID、所有已配置商品的 id、Shop 级 metafield 的 owner（Shop GID）；
 *   ② **再清 Shopify 侧**：删 3 个 automatic discount + 主动删 app-owned metafield
 *      （Shop 级 `tablely.settings` + 每个商品的 `tablely.table`）。app-owned metafield
 *      **不会**随卸载自动消失（M0 结论），必须主动删，否则店面无残留代码但数据仍在；
 *   ③ **最后清 DB**：本店全部业务表（含会话）。
 *
 * ⚠️ **现实约束（如实记录）**：Shopify 在卸载后**会吊销 access token**，因此 ② 只能
 *    **尽力而为** —— `app/uninstalled` 到达时若会话仍在，用离线 token 立刻删；
 *    若已被吊销（常见），删除会抛错，这里**逐个捕获并记日志**，绝不因此让 webhook 500。
 *    这一局限与 M5/M6/M7「dev 店密码保护导致 e2e 未跑」同属**已知且记录在案**的边界；
 *    ② 与 ③ 都是**幂等**的，`shop/redact`（48h 后到达）会再跑一遍同一条清理。
 *
 * ⚠️ 本模块只按 `shop` 条件操作，`shop` 一律由 webhook 签名解析而来（§8.2 A）。
 */

import prisma from "../db.server";
import { logStructured } from "./monitor.server";
import {
    deleteProductTableMetafield,
    deleteShopSettingsMetafield,
    getShopInfo,
    type GraphqlAdmin,
} from "./metafield.server";

/** 清理结果（用于日志与单测断言；不面向商家） */
export type CleanupResult = {
    /** 已尝试删除的 automatic discount 数量 */
    discountsAttempted: number;
    /** 已尝试删除的 metafield 数量（Shop 级 1 + 每个商品 1） */
    metafieldsAttempted: number;
    /** 因 token 已吊销 / API 报错而失败的 Shopify 侧删除数量 */
    shopifyFailures: number;
    /** 已清理的 DB 业务表数量 */
    tablesPurged: number;
};

const DELETE_DISCOUNT_MUTATION = `#graphql
  mutation TablelyDeleteDiscount($id: ID!) {
    discountAutomaticDelete(id: $id) {
      deletedAutomaticDiscountId
      userErrors {
        field
        message
        code
      }
    }
  }
`;

type UserError = { field?: string[]; message: string; code?: string };

/** 删除一个 automatic discount（用户错误抛错，由调用方逐个捕获） */
async function deleteAutomaticDiscount(
    admin: GraphqlAdmin,
    id: string,
): Promise<void> {
    const res = await admin.graphql(DELETE_DISCOUNT_MUTATION, {
        variables: { id },
    });
    const json = (await res.json()) as {
        errors?: { message: string }[];
        data?: { discountAutomaticDelete?: { userErrors?: UserError[] } };
    };
    if (Array.isArray(json.errors) && json.errors.length) {
        throw new Error(json.errors.map((error) => error.message).join("; "));
    }
    const userErrors = json.data?.discountAutomaticDelete?.userErrors;
    if (userErrors?.length) {
        throw new Error(userErrors.map((error) => error.message).join("; "));
    }
}

/** 逐个执行 Shopify 侧删除并计数；单个失败不中断其余删除（幂等、可重跑） */
async function runBestEffort(
    tasks: { label: string; run: () => Promise<void> }[],
    shop: string,
): Promise<{ attempted: number; failures: number }> {
    let failures = 0;
    for (const task of tasks) {
        try {
            await task.run();
        } catch (error) {
            failures += 1;
            logStructured("warn", "uninstall.shopify_cleanup_failed", {
                shop,
                target: task.label,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { attempted: tasks.length, failures };
}

/**
 * 清理某店铺在 Shopify 侧与 DB 侧的全部 Tablely 数据（幂等）。
 *
 * `admin` 可缺省：缺省时跳过 Shopify 侧删除，只清 DB —— 这正是 `shop/redact`
 * 与「token 已吊销」场景下的行为。
 */
export async function cleanupShopData(input: {
    shop: string;
    admin?: GraphqlAdmin | null;
}): Promise<CleanupResult> {
    const { shop } = input;

    // ① 先读：清理前把「Shopify 侧要删什么」取全（DB 清完就查不到了）
    const [discountState, productTables] = await Promise.all([
        prisma.discountState.findUnique({ where: { shop } }),
        prisma.productTable.findMany({
            where: { shop },
            select: { productId: true },
        }),
    ]);

    const discountIds = [
        discountState?.tierDiscountId,
        discountState?.wholeDiscountId,
        discountState?.mixMatchDiscountId,
    ].filter((id): id is string => Boolean(id));

    let discountsAttempted = 0;
    let metafieldsAttempted = 0;
    let shopifyFailures = 0;

    const admin = input.admin ?? undefined;
    if (admin) {
        // ②a 删 3 个 automatic discount
        const discountResult = await runBestEffort(
            discountIds.map((id) => ({
                label: `discount:${id}`,
                run: () => deleteAutomaticDiscount(admin, id),
            })),
            shop,
        );
        discountsAttempted = discountResult.attempted;
        shopifyFailures += discountResult.failures;

        // ②b 主动删 app-owned metafield：Shop 级 + 每个商品的商品级
        const metafieldTasks: { label: string; run: () => Promise<void> }[] = [];
        try {
            const info = await getShopInfo(admin);
            metafieldTasks.push({
                label: "metafield:shop.settings",
                run: () => deleteShopSettingsMetafield(admin, info.id),
            });
        } catch (error) {
            shopifyFailures += 1;
            logStructured("warn", "uninstall.shop_metafield_skipped", {
                shop,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
        for (const table of productTables) {
            metafieldTasks.push({
                label: `metafield:product.${table.productId}`,
                run: () => deleteProductTableMetafield(admin, table.productId),
            });
        }
        const metafieldResult = await runBestEffort(metafieldTasks, shop);
        metafieldsAttempted = metafieldResult.attempted;
        shopifyFailures += metafieldResult.failures;
    } else {
        // 无 admin（token 已吊销 / shop_redact）：Shopify 侧无从下手，仅记录
        discountsAttempted = discountIds.length;
        metafieldsAttempted = productTables.length + 1;
        logStructured("warn", "uninstall.no_admin_context", {
            shop,
            pendingDiscounts: discountIds.length,
            pendingMetafields: productTables.length + 1,
        });
    }

    // ③ 清 DB：本店全部业务表（顺序无外键约束，可并行）
    const purged = await Promise.all([
        prisma.addToCartEvent.deleteMany({ where: { shop } }),
        prisma.customerGroup.deleteMany({ where: { shop } }),
        prisma.discountState.deleteMany({ where: { shop } }),
        prisma.layoutTemplate.deleteMany({ where: { shop } }),
        prisma.mixMatchGroup.deleteMany({ where: { shop } }),
        prisma.mixMatchMember.deleteMany({ where: { shop } }),
        prisma.planState.deleteMany({ where: { shop } }),
        prisma.productTable.deleteMany({ where: { shop } }),
        prisma.quote.deleteMany({ where: { shop } }),
        prisma.session.deleteMany({ where: { shop } }),
        prisma.shopSettings.deleteMany({ where: { shop } }),
        prisma.variantRule.deleteMany({ where: { shop } }),
        prisma.webhookEvent.deleteMany({ where: { shop } }),
        prisma.wholesaleApplication.deleteMany({ where: { shop } }),
        prisma.wholesalePrice.deleteMany({ where: { shop } }),
    ]);

    return {
        discountsAttempted,
        metafieldsAttempted,
        shopifyFailures,
        tablesPurged: purged.length,
    };
}
