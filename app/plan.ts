/**
 * 档位与功能门控（M9）—— **客户端安全**（零 server-only 依赖）
 *
 * 方案 §19.3：Pro 功能统一由单点函数 `hasFeature(plan, "feature")` 判定，
 * **前后端各调一次**（前端禁 UI + Pro 徽章，后端拒写）。
 * 因此本模块不能 import `db.server` / `*.server`（路由组件会引用它，进客户端包）；
 * 需要读库的档位解析在 `services/billing.server.ts` 与 `services/tables.server.ts`。
 *
 * Free / Pro 的差异以方案 §1.4 / §1.6 为唯一权威：Free 只含
 * 3 个商品 · Table 布局 · min/max/step · 含税开关 · 反馈 · 隐藏原生加购 · 7 语言 · Help；
 * 其余（网格/列表/矩阵、列开关、商品级默认、缺货三策略、阶梯价、批发价、门控、
 * 客户组、混单、快速补货、CSV、历史加购预填、报价单、统计、样式自定义、布局模板、
 * 整单起订金额、优先支持）全部属 Pro。
 */

/** 档位（与 `PlanState.plan` 的字符串口径一致） */
export type Plan = "free" | "pro";

export function normalizePlan(value: string | null | undefined): Plan {
    return value === "pro" ? "pro" : "free";
}

/* ------------------------------- 订阅档位 ------------------------------- */

/**
 * 可售档位（M9 §七）：Free $0 永久；Pro $4.99/月 或 $39.90/年（年付省 33%），7 天试用。
 * label / amount / interval 直接喂给 `appSubscriptionCreate`（见 billing.server.ts），
 * 定价页也复用同一份数据，避免两处价格分叉（§19.2）。
 */
export type PlanKey = "pro_monthly" | "pro_annual";

export const PLAN_OPTIONS: Record<
    PlanKey,
    { label: string; amount: number; interval: "EVERY_30_DAYS" | "ANNUAL" }
> = {
    pro_monthly: {
        label: "Tablely Pro (Monthly)",
        amount: 4.99,
        interval: "EVERY_30_DAYS",
    },
    pro_annual: {
        label: "Tablely Pro (Annual)",
        amount: 39.9,
        interval: "ANNUAL",
    },
};

export function isPlanKey(value: string): value is PlanKey {
    return value === "pro_monthly" || value === "pro_annual";
}

/** 试用天数（方案 §七：7 天） */
export const TRIAL_DAYS = 7;

/* ------------------------------ 功能门控 ------------------------------ */

/**
 * Pro 专属功能 key（方案 §1.4 功能号 → 语义名）。
 * 命名按「能力」而非「页面」，一个能力可能出现在多个页面（如布局在两处可选）。
 */
export type ProFeature =
    /** #3 网格 / 列表 / 矩阵布局（Table 布局 Free 可用） */
    | "layout_non_table"
    /** #4 列的显示 / 隐藏 */
    | "column_overrides"
    /** #12 商品级默认值 + 变体级覆写 */
    | "product_defaults"
    /** #13 缺货变体三策略（置灰 / 隐藏 / 允许缺货） */
    | "out_of_stock"
    /** #16 阶梯价（展示 + Function 改价） */
    | "tier_pricing"
    /** #17 批发客户价 */
    | "wholesale_price"
    /** #19 门控（off / hide_price / hide_table） */
    | "gating"
    /** #19 客户组（标签）管理 */
    | "customer_groups"
    /** #20 申请表单自定义字段 */
    | "custom_form"
    /** #21 后台审批流 */
    | "approvals"
    /** #22 快速补货落脚页 */
    | "quick_order"
    /** #23 / #29 / #38 CSV 导入导出与模板 */
    | "csv"
    /** #24 / #37 历史加购再下单与预填 */
    | "reorder"
    /** #25 报价单导出 */
    | "quote"
    /** #26 加购统计 */
    | "stats"
    /** #27 样式自定义（品牌色 / 圆角 / 密度 / 字体） */
    | "custom_style"
    /** #28 布局模板 */
    | "layout_templates"
    /** #35 Mix & Match 混单折扣 */
    | "mix_match"
    /** #36 整单起订金额（店铺级默认 + 商品级覆写） */
    | "order_minimum"
    /** #31 优先支持（邮件 1 个工作日）——纯展示，不门控任何输入 */
    | "priority_support";

export const PRO_FEATURES: readonly ProFeature[] = [
    "layout_non_table",
    "column_overrides",
    "product_defaults",
    "out_of_stock",
    "tier_pricing",
    "wholesale_price",
    "gating",
    "customer_groups",
    "custom_form",
    "approvals",
    "quick_order",
    "csv",
    "reorder",
    "quote",
    "stats",
    "custom_style",
    "layout_templates",
    "mix_match",
    "order_minimum",
    "priority_support",
];

const PRO_FEATURE_SET = new Set<string>(PRO_FEATURES);

/**
 * 单点门控判定（§19.3）：Pro 功能仅 Pro 可用。
 * 前端用它禁 UI + 显示 Pro 徽章，后端用它拒写（同一份真源，不会分叉）。
 */
export function hasFeature(plan: Plan, feature: ProFeature): boolean {
    return plan === "pro" && PRO_FEATURE_SET.has(feature);
}

/* --------------------------- 非 table 布局判定 --------------------------- */

/** 可选的订购表布局（§六 / §十三；`table` 为 Free 唯一可用布局） */
export const LAYOUTS = ["table", "grid", "list", "matrix"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** 是否属于 Pro 专属布局（非 `table`） */
export function isProLayout(layout: string | null | undefined): boolean {
    return layout === "grid" || layout === "list" || layout === "matrix";
}