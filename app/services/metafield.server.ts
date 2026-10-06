/**
 * Tablely 渲染契约（metafield）—— 唯一生成处（§2.7 / §五）
 *
 * 两份 metafield，**owner 类型不同**：
 *   ① Shop 级    namespace `tablely` / key `settings`，owner = **Shop**
 *   ② Product 级 namespace `tablely` / key `table`，owner = **Product**
 *
 * ⚠️ **namespace 用 plain `tablely`（不是 `$app:tablely`）** —— 这是 M0 在 dev 店的实测结论：
 *   两份 metafield 必须配套建 `metafieldDefinition` 且 `access.storefront = PUBLIC_READ`，
 *   店面 Liquid 才能用 `shop.metafields.tablely.settings` / `product.metafields.tablely.table`
 *   读到值；否则读到的是 `nil`（应用/商家私有 metafield 默认对店面不可见）。
 *   故安装流程的顺序是「**建定义 → 再写值 → 渲染兜底**」（见 `ensureMetafieldDefinitions`）。
 *
 * ⚠️ **不含价格与库存（A1）** —— `rows[]` 只有配置类的 `min / max / step / tiers / wholesale`；
 *   价格与库存一律由主题 Liquid 从 `variant` 对象实时读（`variant.price` /
 *   `variant.inventory_quantity` / `variant.available`）。契约里**不得出现** `price` /
 *   `priceIncl` / `stock`（§十二 验收 12）。
 *
 * 金额一律用十进制**字符串**（`"1000.00"`），避免浮点误差。
 */

import {
    DEFAULT_NATIVE_SELECTOR,
    DENSITIES,
    FEEDBACK_STYLES,
    FONTS,
    GATE_MODES,
    OUT_OF_STOCK_MODES,
    RADIUS_MAX,
    RADIUS_MIN,
    TAX_DISPLAYS,
    TIER_MODELS,
    type Density,
    type FeedbackStyle,
    type FontChoice,
    type ShopStyleContract,
} from "../design-choices";

/* ================================ 常量 ================================ */

/** metafield namespace（两份 metafield 共用；**不是** `$app:` 前缀，见文件头说明） */
export const NAMESPACE = "tablely";
export const TABLE_KEY = "table";
export const SETTINGS_KEY = "settings";

/** 布局取值（§五；Product 级 `layout` 为 `null` 时继承 Shop 级 `defaultLayout`） */
export const LAYOUTS = ["table", "grid", "list", "matrix"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const DEFAULT_LAYOUT: Layout = "table";

/** 列开关的默认值（§五；Shop 级给默认，Product 级按需覆写） */
export const COLUMN_KEYS = ["image", "sku", "id", "price", "stock"] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export type ColumnFlags = Record<ColumnKey, boolean>;
export const DEFAULT_COLUMNS: ColumnFlags = {
    image: true,
    sku: true,
    id: false,
    price: true,
    stock: true,
};

/**
 * Design 相关取值（含税 / 缺货 / 密度 / 字体 / 反馈方式 / 隐藏选择器 / 圆角范围）
 * 与 `DESIGN_CHOICES` 的真源在 `app/design-choices.ts`（客户端安全），这里 import 后再导出，
 * 保证「服务端归一化」与「后端下拉」共用同一份白名单（M8）。
 */
export {
    TAX_DISPLAYS,
    OUT_OF_STOCK_MODES,
    DEFAULT_NATIVE_SELECTOR,
    NATIVE_SELECTOR_CANDIDATES,
    DENSITIES,
    FONTS,
    FEEDBACK_STYLES,
    RADIUS_MIN,
    RADIUS_MAX,
} from "../design-choices";
export type {
    Density,
    FontChoice,
    FeedbackStyle,
    ShopStyleContract,
} from "../design-choices";

/**
 * 门控模式（§五 gate；Liquid 侧按 `customer.tags` 实时比对，M10 落地）
 * 与阶梯价模型（§2.2：A = 百分比 / B = 固定单价；M12 落地）。
 *
 * 真源在 `app/design-choices.ts`（客户端安全，M8 同法）：路由组件要用同一份白名单
 * 渲染下拉，直接 import 本 `.server.ts` 会把 server-only 模块拖进客户端包。
 */
export { GATE_MODES, TIER_MODELS };

/* ============================== 契约类型 ============================== */

/**
 * 档位（§五 `rows[].tiers`；B6 的 `defaultTiers` 由 M12 展开进各变体，Liquid 只认这里）。
 *
 * 两种模型（§2.2）二选一：`percent`（模型 A，百分比）或 `price`（模型 B，固定单价）。
 * 同一档位**不同时**携带两者；`normalizeTiers` 已保证形态合法。
 */
export type TierEntry = { qty: number; price?: string; percent?: number };

/** 批发价（§五 `rows[].wholesale`；B5 一个变体可挂多组，M10/M12 落值） */
export type WholesaleEntry = { group: string; price: string };

/** Product 级 `table` metafield 的一行（**每行字段结构必须一致**；不含 price / stock） */
export type TableContractRow = {
    /** 纯数字变体 ID（与 Liquid 的 `variant.id` 对齐） */
    vid: string;
    sku: string | null;
    title: string;
    min: number;
    max: number | null;
    step: number;
    tiers: TierEntry[];
    wholesale: WholesaleEntry[];
};

/** 矩阵的一个轴（§五 `matrix`）：option 名 + 取值（取值即表头顺序） */
export type MatrixAxis = {
    name: string;
    values: string[];
};

/**
 * 矩阵布局坐标（§五 `matrix`；M6 落值）。
 *
 * 矩阵 = **按 option 交叉**：行 = 商品第 1 个 option 的取值，列 = 第 2 个 option 的取值；
 * `cells` 把每个格子指向一个变体，**没有对应项的格子即空**（不补 `null`）。
 * 全是配置类数据（option 名 / 取值 / 变体 id），**不含价格与库存**（A1）。
 */
export type MatrixContract = {
    /** 列轴（商品第 2 个 option） */
    xAxis: MatrixAxis;
    /** 行轴（商品第 1 个 option） */
    yAxis: MatrixAxis;
    cells: { x: number; y: number; vid: string }[];
};

/** 商品 option（Admin API → 矩阵轴；`values` 保持 Shopify 的顺序） */
export type ProductOptionLike = { name: string; values: string[] };
/** 变体所选 option（Admin API `selectedOptions`） */
export type VariantOptionLike = { vid: string; options: { name: string; value: string }[] };

/** Product 级 `table` metafield 契约 v2（§五 ②） */
export type ProductTableContract = {
    v: 2;
    enabled: boolean;
    /** 覆写全局布局；`null` = 继承 Shop 级 `defaultLayout` */
    layout: Layout | null;
    /** 列开关覆写（只带商家改过的键；Liquid 按「默认 → Shop → Product」合并） */
    columns: Partial<ColumnFlags>;
    /**
     * Y14 整单起订金额覆写：十进制字符串（如 `"1000.00"`）；
     * `null` = 继承 Shop 级默认（两者都为 null 即不限）。
     * ⚠️ 留空必须落 `null`，**不可写 `"0"`**——`0` 与「不限」语义完全不同。
     */
    orderMinAmount: string | null;
    rows: TableContractRow[];
    /** 矩阵布局坐标；M4 恒为 `null`（M6 生成） */
    matrix: MatrixContract | null;
};

/** Shop 级 `settings` metafield 契约 v2（§五 ①） */
export type ShopSettingsContract = {
    v: 2;
    defaultLayout: Layout;
    columns: ColumnFlags;
    taxDisplay: (typeof TAX_DISPLAYS)[number];
    /** 门控模式 + 合格客户标签（静态 metafield 不存「某位顾客是否可见」） */
    gate: { mode: (typeof GATE_MODES)[number]; tags: string[] };
    outOfStock: (typeof OUT_OF_STOCK_MODES)[number];
    /** Y14：店铺级默认整单起订金额（字符串 / `null` = 不限）；商品可覆写 */
    orderMinAmount: string | null;
    tierModel: (typeof TIER_MODELS)[number];
    tierEnabled: boolean;
    /** B1：隐藏主题自带加购区（默认关闭） */
    hideNative: { enabled: boolean; selector: string };
    /** M8：外观样式（品牌色 / 圆角 / 密度 / 字体） */
    style: ShopStyleContract;
    /** M8：反馈呈现方式（inline / toast / both） */
    feedbackStyle: FeedbackStyle;
    /**
     * M13：店面加购上报地址（`${SHOPIFY_APP_URL}/api/addtocart`）。
     * 空串 = 应用地址未配置，店面据此**跳过上报**（绝不因此影响加购）。
     */
    reportUrl: string;
    /**
     * M14：App Block 渲染检测地址（`${SHOPIFY_APP_URL}/api/track`）。
     * 店面增强层初始化时 fire-and-forget 打一次，应用据此写 `blockAddedAt`（Y1 激活漏斗）。
     * 空串 = 应用地址未配置，店面**跳过**（绝不影响渲染）。
     */
    trackUrl: string;
};

/** 序列化 Shop 级契约所需的 DB 行（结构性类型，避免把 Prisma 拖进单测） */
export type ShopSettingsRowLike = {
    defaultLayout: string;
    columns: unknown;
    taxDisplay: string;
    outOfStockMode: string;
    gateMode: string;
    gateTags: string[];
    tierModel: string;
    tierEnabled: boolean;
    hideNative: boolean;
    nativeSelector: string | null;
    orderMinAmount: unknown;
    /** M8：外观样式（JSON：brandColor / radius / density / font） */
    theme: unknown;
    /** M8：反馈呈现方式（inline / toast / both） */
    feedbackStyle: string;
};

/* ============================== 纯函数 ============================== */

/** 白名单归一化：命中则用原值，否则退回 fallback（避免脏值进店面契约） */
function pick<T extends string>(
    allowed: readonly T[],
    value: unknown,
    fallback: T,
): T {
    return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Decimal → 十进制字符串（`null` / 非法保持 `null`；0 也要如实输出 `"0.00"`） */
export function formatAmount(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.trim() === "" ? null : value;
    if (typeof value === "object" && typeof (value as { toFixed?: unknown }).toFixed === "function") {
        return (value as { toFixed: (digits: number) => string }).toFixed(2);
    }
    return null;
}

/**
 * 列开关归一化：以 `DEFAULT_COLUMNS` 为底，只接受显式的布尔值覆写。
 *
 * 支持多份来源依次合并（默认 → Shop 级 → Product 级），后写的赢。
 */
export function mergeColumns(...sources: unknown[]): ColumnFlags {
    const result: ColumnFlags = { ...DEFAULT_COLUMNS };
    for (const source of sources) {
        if (!source || typeof source !== "object") continue;
        for (const key of COLUMN_KEYS) {
            const value = (source as Record<string, unknown>)[key];
            if (typeof value === "boolean") result[key] = value;
        }
    }
    return result;
}

/** 布局归一化：`null` = 继承 Shop 级；非法值一律退回 `null`（不写脏值进契约） */
export function normalizeLayout(value: unknown): Layout | null {
    if (value === null || value === undefined || value === "") return null;
    return LAYOUTS.includes(value as Layout) ? (value as Layout) : null;
}

/** 只保留显式布尔值（写进 Product 级契约的「覆写」形态，不把默认值抄进来） */
export function pickColumnOverrides(source: unknown): Partial<ColumnFlags> {
    const result: Partial<ColumnFlags> = {};
    if (!source || typeof source !== "object") return result;
    for (const key of COLUMN_KEYS) {
        const value = (source as Record<string, unknown>)[key];
        if (typeof value === "boolean") result[key] = value;
    }
    return result;
}

/**
 * 档位数组归一化（M12 / §2.2）：只接受 `{qty, percent}` 或 `{qty, price}` 形态。
 *
 * - `qty` 必须是 ≥ 1 的整数（向下取整），否则丢弃该档；
 * - `percent` 优先（模型 A）：`0 < percent ≤ 100` 的有限数；
 * - 否则退 `price`（模型 B）：非空十进制字符串，**不在此处转数字**（金额全程字符串）；
 * - 两者皆无的脏档位一律丢弃，绝不写进店面契约。
 */
export function normalizeTiers(source: unknown): TierEntry[] {
    if (!Array.isArray(source)) return [];
    const result: TierEntry[] = [];
    for (const entry of source) {
        if (!entry || typeof entry !== "object") continue;
        const raw = entry as Record<string, unknown>;
        const qty = Math.floor(Number(raw.qty));
        if (!Number.isFinite(qty) || qty < 1) continue;
        const percent = Number(raw.percent);
        if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
            result.push({ qty, percent });
            continue;
        }
        const price =
            typeof raw.price === "string" && raw.price.trim() !== ""
                ? raw.price.trim()
                : null;
        if (price) result.push({ qty, price });
    }
    return result;
}

/* ----------------------- M8：Design 值归一化 ----------------------- */

/**
 * 品牌色归一化：接受 `#rgb` / `#rrggbb`（大小写不敏感），统一输出小写 `#rrggbb`。
 * 非法值一律返回 `null`（= 跟随主题 `currentColor`），**绝不把脏值写进店面 CSS**。
 */
export function normalizeBrandColor(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const raw = value.trim();
    const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
    if (!match) return null;
    const hex = match[1].toLowerCase();
    const full =
        hex.length === 3
            ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
            : hex;
    return `#${full}`;
}

/** 圆角归一化：0–24 的整数 px；非法 / 越界返回 `null`（= 用默认） */
export function normalizeRadius(value: unknown): number | null {
    const num =
        typeof value === "number"
            ? value
            : typeof value === "string" && value.trim() !== ""
                ? Number(value)
                : Number.NaN;
    if (!Number.isFinite(num)) return null;
    const rounded = Math.round(num);
    if (rounded < RADIUS_MIN || rounded > RADIUS_MAX) return null;
    return rounded;
}

/** 密度归一化（白名单，默认 `default`） */
export function normalizeDensity(value: unknown): Density {
    return pick(DENSITIES, value, "default");
}

/** 字体归一化（白名单，默认 `inherit` = 跟随主题） */
export function normalizeFont(value: unknown): FontChoice {
    return pick(FONTS, value, "inherit");
}

/** 反馈方式归一化（白名单，默认 `inline`） */
export function normalizeFeedbackStyle(value: unknown): FeedbackStyle {
    return pick(FEEDBACK_STYLES, value, "inline");
}

/**
 * 隐藏开关的 CSS 选择器消毒（M8 安全底线，§2.8 / §十二 验收 15）。
 *
 * 选择器由商家在 Design 页自由填写，最终会被拼进店面 `<style>` ——
 * 若含 `{ } < > ; \` 或换行，就能**逃出规则**注入任意 CSS（甚至伪内容）。
 * 这里直接剔除这些危险字符（而不是转义），保持「只可能是选择器」的形态；
 * 消毒后为空则退回内置默认选择器。
 */
export function sanitizeSelector(value: unknown): string {
    if (typeof value !== "string") return DEFAULT_NATIVE_SELECTOR;
    const cleaned = value
        .replace(/[{}<>;\\]/g, "")
        .replace(/[\r\n\t]+/g, " ")
        .trim();
    return cleaned || DEFAULT_NATIVE_SELECTOR;
}

/** DB 的 `theme` JSON → 外观契约（`null` / 脏结构一律回退默认，不抛错） */
export function toShopStyleContract(theme: unknown): ShopStyleContract {
    const source = (theme && typeof theme === "object" ? theme : {}) as Record<
        string,
        unknown
    >;
    return {
        brandColor: normalizeBrandColor(source.brandColor),
        radius: normalizeRadius(source.radius),
        density: normalizeDensity(source.density),
        font: normalizeFont(source.font),
    };
}

/**
 * M13：店面加购上报地址。
 *
 * 由**应用自身**的 `SHOPIFY_APP_URL` 拼出（不取店铺域名，故跨域且不受自定义域影响，
 * 与 Linkly 的 click 上报同一思路）。未配置时返回空串，店面侧会跳过上报。
 */
export function resolveReportUrl(): string {
    const base = (process.env.SHOPIFY_APP_URL ?? "").trim().replace(/\/+$/, "");
    return base ? `${base}/api/addtocart` : "";
}

/**
 * M14：App Block 渲染检测上报地址（Y1 激活漏斗 `blockAddedAt`）。
 *
 * 与 `resolveReportUrl` 同法：未配置 `SHOPIFY_APP_URL` 时返回空串，店面侧跳过。
 */
export function resolveTrackUrl(): string {
    const base = (process.env.SHOPIFY_APP_URL ?? "").trim().replace(/\/+$/, "");
    return base ? `${base}/api/track` : "";
}

/** DB 行 → Shop 级契约（**唯一生成处**；Design 页保存与 afterAuth 播种共用） */
export function toShopSettingsContract(
    row: ShopSettingsRowLike,
): ShopSettingsContract {
    return {
        v: 2,
        defaultLayout: pick(LAYOUTS, row.defaultLayout, DEFAULT_LAYOUT),
        columns: mergeColumns(row.columns),
        taxDisplay: pick(TAX_DISPLAYS, row.taxDisplay, "incl"),
        gate: {
            mode: pick(GATE_MODES, row.gateMode, "off"),
            // 标签去重去空：门控比对是精确匹配，留着空串会把「无标签顾客」误放行
            tags: [...new Set((row.gateTags ?? []).map((tag) => tag.trim()).filter(Boolean))],
        },
        outOfStock: pick(OUT_OF_STOCK_MODES, row.outOfStockMode, "gray"),
        orderMinAmount: formatAmount(row.orderMinAmount),
        tierModel: pick(TIER_MODELS, row.tierModel, "percent"),
        tierEnabled: Boolean(row.tierEnabled),
        hideNative: {
            enabled: Boolean(row.hideNative),
            // 消毒后为空会退回内置默认；**绝不原样输出商家输入**（§2.8 安全兜底）
            selector: sanitizeSelector(row.nativeSelector),
        },
        style: toShopStyleContract(row.theme),
        feedbackStyle: normalizeFeedbackStyle(row.feedbackStyle),
        reportUrl: resolveReportUrl(),
        trackUrl: resolveTrackUrl(),
    };
}

/** 构建 Shop 级 `settings` metafield 的 JSON 值（**唯一生成处**） */
export function buildShopSettingsValue(contract: ShopSettingsContract): string {
    return JSON.stringify(contract);
}

/** 构建 Product 级 `table` metafield 的 JSON 值（**唯一生成处**） */
export function buildProductTableValue(contract: ProductTableContract): string {
    return JSON.stringify(contract);
}

/**
 * 由商品 option 与变体生成矩阵坐标（§2.3 / §五；M6 落地）。
 *
 * 硬约束（§1.4 #3 / §十三 C9）：**恰好 2 个 option 轴**才能成矩阵 ——
 *   · 0 / 1 个 option 构不成「交叉」，≥3 个会指数爆炸，**一律返回 `null`**；
 *   · 返回 `null` 时 Liquid 侧自动降级为表格布局（不报错、不留空白）。
 * 行轴 = 第 1 个 option，列轴 = 第 2 个 option（与「规格 × 包装重量」的直观一致）。
 * 变体若缺某个轴上的取值（理论上不会），跳过该格子而不是伪造坐标。
 */
export function buildMatrix(
    options: ProductOptionLike[],
    variants: VariantOptionLike[],
): MatrixContract | null {
    const rowOption = options[0];
    const colOption = options[1];
    if (options.length !== 2 || !rowOption || !colOption) return null;
    if (!rowOption.name || !colOption.name) return null;

    const rowValues = [...rowOption.values];
    const colValues = [...colOption.values];
    if (!rowValues.length || !colValues.length) return null;

    const cells: MatrixContract["cells"] = [];
    for (const variant of variants) {
        const yValue = variant.options.find((item) => item.name === rowOption.name)?.value;
        const xValue = variant.options.find((item) => item.name === colOption.name)?.value;
        if (yValue === undefined || xValue === undefined) continue;
        const y = rowValues.indexOf(yValue);
        const x = colValues.indexOf(xValue);
        if (x < 0 || y < 0) continue;
        cells.push({ x, y, vid: variant.vid });
    }
    if (!cells.length) return null;

    return {
        xAxis: { name: colOption.name, values: colValues },
        yAxis: { name: rowOption.name, values: rowValues },
        cells,
    };
}

/* ============================== 写 metafield ============================== */

export type GraphqlAdmin = {
    graphql: (
        query: string,
        options?: { variables?: Record<string, unknown> },
    ) => Promise<Response>;
};

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

type UserError = { field?: string[]; message: string; code?: string };

function throwOnUserErrors(
    userErrors: UserError[] | undefined,
    context: string,
): void {
    if (!userErrors?.length) return;
    throw new Error(
        `[tablely] ${context}: ${userErrors
            .map((error) => [...(error.field ?? []), error.message].join(" "))
            .join("; ")}`,
    );
}

/** 写入一份 json metafield（owner 由 `ownerId` 决定：Shop 或 Product） */
async function setJsonMetafield(
    admin: GraphqlAdmin,
    input: { ownerId: string; key: string; value: string },
    context: string,
): Promise<void> {
    const res = await admin.graphql(SET_METAFIELDS_MUTATION, {
        variables: {
            metafields: [
                {
                    ownerId: input.ownerId,
                    namespace: NAMESPACE,
                    key: input.key,
                    type: "json",
                    value: input.value,
                },
            ],
        },
    });

    const json = await res.json();
    assertNoGraphqlErrors(json, context);
    throwOnUserErrors(
        (json as {
            data?: { metafieldsSet?: { userErrors?: UserError[] } };
        })?.data?.metafieldsSet?.userErrors,
        context,
    );
}

/** 写入 Shop 级 `tablely.settings`（失败必须抛错，不允许静默成功，§六） */
export async function syncShopSettingsMetafield(
    admin: GraphqlAdmin,
    shopId: string,
    value: string,
): Promise<void> {
    await setJsonMetafield(
        admin,
        { ownerId: shopId, key: SETTINGS_KEY, value },
        "syncShopSettingsMetafield",
    );
}

/** 写入 Product 级 `tablely.table`（失败必须抛错，不允许静默成功，§六） */
export async function syncProductTableMetafield(
    admin: GraphqlAdmin,
    productId: string,
    value: string,
): Promise<void> {
    await setJsonMetafield(
        admin,
        { ownerId: productId, key: TABLE_KEY, value },
        "syncProductTableMetafield",
    );
}

/** 删除某个商品的 `tablely.table`（幂等：不存在时视为已删除） */
export async function deleteProductTableMetafield(
    admin: GraphqlAdmin,
    productId: string,
): Promise<void> {
    const res = await admin.graphql(DELETE_METAFIELDS_MUTATION, {
        variables: {
            metafields: [
                { ownerId: productId, namespace: NAMESPACE, key: TABLE_KEY },
            ],
        },
    });

    const json = await res.json();
    assertNoGraphqlErrors(json, "deleteProductTableMetafield");
    throwOnUserErrors(
        (json as {
            data?: { metafieldsDelete?: { userErrors?: UserError[] } };
        })?.data?.metafieldsDelete?.userErrors,
        "deleteProductTableMetafield",
    );
}

/**
 * 删除 Shop 级 `tablely.settings`（卸载 / shop_redact 清理，§8.1 / §十二 验收 10）。
 *
 * 与商品级一样是 **app-owned metafield**：Shopify 卸载时**不会**自动清（M0 结论），
 * 必须由应用主动删。幂等：不存在也不报错。
 */
export async function deleteShopSettingsMetafield(
    admin: GraphqlAdmin,
    shopId: string,
): Promise<void> {
    const res = await admin.graphql(DELETE_METAFIELDS_MUTATION, {
        variables: {
            metafields: [
                { ownerId: shopId, namespace: NAMESPACE, key: SETTINGS_KEY },
            ],
        },
    });

    const json = await res.json();
    assertNoGraphqlErrors(json, "deleteShopSettingsMetafield");
    throwOnUserErrors(
        (json as {
            data?: { metafieldsDelete?: { userErrors?: UserError[] } };
        })?.data?.metafieldsDelete?.userErrors,
        "deleteShopSettingsMetafield",
    );
}

/* ============================== 店铺信息 ============================== */

const SHOP_QUERY = `#graphql
  query TablelyShop {
    shop {
      id
      currencyCode
    }
  }
`;

/** 店铺 GID 与本位币（Shop 级 metafield 的 owner、起订金额字段的 suffix） */
export async function getShopInfo(
    admin: GraphqlAdmin,
): Promise<{ id: string; currencyCode: string }> {
    const res = await admin.graphql(SHOP_QUERY);
    const json = await res.json();
    assertNoGraphqlErrors(json, "getShopInfo");

    const shop = (json as { data?: { shop?: { id?: string; currencyCode?: string } } })
        ?.data?.shop;
    if (!shop?.id) {
        throw new Error("[tablely] getShopInfo: 未能取到 shop.id");
    }
    return { id: shop.id, currencyCode: shop.currencyCode ?? "USD" };
}

/* ========================= metafield 定义（店面可见性） ========================= */

const DEFINITIONS_QUERY = `#graphql
  query TablelyMetafieldDefinitions {
    shopDefinitions: metafieldDefinitions(
      ownerType: SHOP
      namespace: "${NAMESPACE}"
      first: 20
    ) {
      nodes {
        key
      }
    }
    productDefinitions: metafieldDefinitions(
      ownerType: PRODUCT
      namespace: "${NAMESPACE}"
      first: 20
    ) {
      nodes {
        key
      }
    }
  }
`;

const CREATE_DEFINITION_MUTATION = `#graphql
  mutation TablelyCreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * 确保两份 metafield 的**定义**存在且 `access.storefront = PUBLIC_READ`。
 *
 * 为什么必须有：店面 Liquid 用 `shop.metafields.tablely.settings` /
 * `product.metafields.tablely.table` 读值，而私有 metafield 默认对店面不可见 ——
 * M0 实测「定义建好前读不到、建好后读得到」（文件头硬约束）。
 *
 * 幂等：先查后建，已存在的 key 不再创建；`access.admin` 整体省略
 * （M0 实测该 API 版本不接受 `MERCHANT_READ`，省略即得 `PUBLIC_READ_WRITE`）。
 *
 * ⚠️ 调用顺序必须是「本函数 → 再写值」，否则先写的那次在店面读不到。
 */
export async function ensureMetafieldDefinitions(
    admin: GraphqlAdmin,
): Promise<{ created: string[] }> {
    const res = await admin.graphql(DEFINITIONS_QUERY);
    const json = await res.json();
    assertNoGraphqlErrors(json, "ensureMetafieldDefinitions");

    const data = (json as {
        data?: {
            shopDefinitions?: { nodes?: { key: string }[] };
            productDefinitions?: { nodes?: { key: string }[] };
        };
    })?.data;
    const existingShop = new Set(
        (data?.shopDefinitions?.nodes ?? []).map((node) => node.key),
    );
    const existingProduct = new Set(
        (data?.productDefinitions?.nodes ?? []).map((node) => node.key),
    );

    const wanted: {
        ownerType: "SHOP" | "PRODUCT";
        key: string;
        name: string;
        exists: boolean;
    }[] = [
            {
                ownerType: "SHOP",
                key: SETTINGS_KEY,
                name: "Tablely settings",
                exists: existingShop.has(SETTINGS_KEY),
            },
            {
                ownerType: "PRODUCT",
                key: TABLE_KEY,
                name: "Tablely order table",
                exists: existingProduct.has(TABLE_KEY),
            },
        ];

    const created: string[] = [];
    for (const item of wanted) {
        if (item.exists) continue;
        const createRes = await admin.graphql(CREATE_DEFINITION_MUTATION, {
            variables: {
                definition: {
                    name: item.name,
                    namespace: NAMESPACE,
                    key: item.key,
                    type: "json",
                    ownerType: item.ownerType,
                    access: { storefront: "PUBLIC_READ" },
                },
            },
        });
        const createJson = await createRes.json();
        assertNoGraphqlErrors(createJson, `ensureMetafieldDefinitions(${item.key})`);
        throwOnUserErrors(
            (createJson as {
                data?: {
                    metafieldDefinitionCreate?: { userErrors?: UserError[] };
                };
            })?.data?.metafieldDefinitionCreate?.userErrors,
            `ensureMetafieldDefinitions(${item.key})`,
        );
        created.push(item.key);
    }

    return { created };
}