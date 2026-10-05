/**
 * CSV 列头真源（M13 / §15.5）—— **客户端安全**（零 server-only 依赖）
 *
 * 单独成文件的原因与其他「客户端安全常量」一致：`csv.server.ts` 是 server-only，
 * 而路由组件 / 单测可能要引用列头（列头冻结的红线要求**只有这一处定义**）。
 *
 * ⚠️ **列头冻结（破坏性变更红线）**：只允许在**末尾追加**，
 * **不改名、不删除、不本地化**（`en` 固定，便于跨语言 / 跨版本互相导入）。
 * 导入时列头与本数组不一致 → 整体报错，绝不静默错列（§15.6）。
 */

export const CSV_COLUMNS = [
    "sku",
    "variant_id",
    "product_title",
    "variant_title",
    "quantity",
    "min_qty",
    "max_qty",
    "step_qty",
    "order_min_amount",
    "tier_qty",
    "tier_price",
    "tier_percent",
] as const;