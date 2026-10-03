/**
 * Tablely 配置下发（metafield）
 *
 * 商品级 → **app-owned** metafield（写入 namespace `$app:tablely` / key `table`）
 *   写入时 namespace 写 `$app:tablely`，Admin API 回读与 Liquid 侧看到的是
 *   `app--<app_id>--tablely`（与 Linkly 的 `$app:linkly` 同一机制）。
 *   §2.7：`tablely.table` 在**商家于 Tables 页保存该商品时**写入。
 *
 * 店铺级 → app-data metafield（namespace `tablely` / key `settings`）
 *   由 Design 页（M8）/ afterAuth 播种写入，M3 不涉及（`orderMinAmount` 的店铺级
 *   默认值在 M3 只落 DB，随后由 M4 的渲染契约统一序列化下发）。
 *
 * 契约（§五）：**不含价格与库存**（A1）——`rows[]` 里只有配置类的
 * `min / max / step / tiers`，价格与库存由主题 Liquid 从 `variant` 实时读。
 * 金额一律用十进制**字符串**（`wholesale.price` 同一口径），避免浮点误差。
 *
 * ⚠️ M4 会把本文件扩成完整的渲染契约（含 Shop 级 `settings` 与 matrix /
 * hideNative 等字段）；M3 只落 Product 级 `table` 所需的字段，形状与 §五 契约对齐。
 */

export type GraphqlAdmin = {
    graphql: (
        query: string,
        options?: { variables?: Record<string, unknown> },
    ) => Promise<Response>;
};

/** 商品级 app-owned metafield（写入用 `$app:` 前缀，回读是 `app--<id>--tablely`） */
export const APP_OWNED_NAMESPACE = "$app:tablely";
export const TABLE_KEY = "table";

const SET_METAFIELDS_MUTATION = `#graphql
  mutation TablelySetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DELETE_METAFIELDS_MUTATION = `#graphql
  mutation TablelyDeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        ownerId
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function assertNoGraphqlErrors(json: unknown, context: string) {
    const errors = (json as { errors?: { message: string }[] })?.errors;
    if (Array.isArray(errors) && errors.length) {
        throw new Error(
            `[tablely] ${context}: ${errors.map((error) => error.message).join("; ")}`,
        );
    }
}

/** 商品级 `table` metafield 的一行（§五 契约；**不含** price / stock） */
export type TableContractRow = {
    /** 纯数字变体 ID（与 Liquid 的 `variant.id` 对齐） */
    vid: string;
    sku: string | null;
    title: string;
    min: number;
    max: number | null;
    step: number;
    /** 档位表；M3 不配档位（阶梯价属 M12），恒为 `[]` */
    tiers: unknown[];
};

/** 商品级 `table` metafield 契约 v2（§五） */
export type ProductTableContract = {
    v: 2;
    enabled: boolean;
    /** 覆写全局布局；`null` = 继承 Shop 级默认 */
    layout: string | null;
    /** 列开关覆写（M3 不出 UI，保留现状） */
    columns: Record<string, boolean>;
    /**
     * Y14 整单起订金额覆写：十进制字符串（如 `"1000.00"`）；
     * `null` = 继承 Shop 级默认（两者都为 null 即不限）。
     * ⚠️ 留空必须落 `null`，**不可写 `"0"`**——`0` 与「不限」语义完全不同。
     */
    orderMinAmount: string | null;
    rows: TableContractRow[];
};

/** 构建商品级 `table` metafield 的 JSON 值（**唯一生成处**，禁止各处自行拼 JSON） */
export function buildProductTableValue(contract: ProductTableContract): string {
    return JSON.stringify(contract);
}

/** 写入某个商品的 app-owned metafield；失败必须抛错，不允许静默成功（§六） */
export async function syncProductTableMetafield(
    admin: GraphqlAdmin,
    productId: string,
    value: string,
): Promise<void> {
    const res = await admin.graphql(SET_METAFIELDS_MUTATION, {
        variables: {
            metafields: [
                {
                    ownerId: productId,
                    namespace: APP_OWNED_NAMESPACE,
                    key: TABLE_KEY,
                    type: "json",
                    value,
                },
            ],
        },
    });

    const json = await res.json();
    assertNoGraphqlErrors(json, "syncProductTableMetafield");

    const userErrors =
        (json as { data?: { metafieldsSet?: { userErrors?: { field?: string[]; message: string }[] } } })
            ?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length) {
        throw new Error(
            `[tablely] syncProductTableMetafield: ${userErrors
                .map((error) => [...(error.field ?? []), error.message].join(" "))
                .join("; ")}`,
        );
    }
}

/** 删除某个商品的 `table` metafield（幂等：不存在时视为已删除） */
export async function deleteProductTableMetafield(
    admin: GraphqlAdmin,
    productId: string,
): Promise<void> {
    const res = await admin.graphql(DELETE_METAFIELDS_MUTATION, {
        variables: {
            metafields: [
                {
                    ownerId: productId,
                    namespace: APP_OWNED_NAMESPACE,
                    key: TABLE_KEY,
                },
            ],
        },
    });

    const json = await res.json();
    assertNoGraphqlErrors(json, "deleteProductTableMetafield");

    const userErrors =
        (json as { data?: { metafieldsDelete?: { userErrors?: { field?: string[]; message: string }[] } } })
            ?.data?.metafieldsDelete?.userErrors ?? [];
    if (userErrors.length) {
        throw new Error(
            `[tablely] deleteProductTableMetafield: ${userErrors
                .map((error) => [...(error.field ?? []), error.message].join(" "))
                .join("; ")}`,
        );
    }
}