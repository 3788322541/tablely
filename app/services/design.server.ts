/**
 * Design 页读写（M8，方案 §六 Design / §2.8）
 *
 * 三段配置全部落在 **ShopSettings 一行**上，保存后立即重建并下发
 * `tablely.settings` metafield（`pushShopSettingsMetafield`），店面 Liquid
 * 下一次渲染即生效 —— 「样式即时生效」不依赖主题改动，也不依赖重新部署（M8 验收）。
 *
 * 分工：
 *   · 外观（品牌色 / 圆角 / 密度 / 字体）—— 进契约 `style`，Liquid 输出 CSS 变量；
 *   · 行为（含税显示 / 缺货策略 / 反馈样式）—— 进契约 `taxDisplay` / `outOfStock` / `feedbackStyle`；
 *   · 隐藏主题自带加购区（B1）—— `hideNative` 布尔 + `nativeSelector` 字符串，
 *     选择器**保存前消毒**（`sanitizeSelector`），店面侧再受安全兜底约束（§2.8）。
 *
 * ⚠️ Pro 门控（外观属 Pro）按方案统一推迟到 **M9 付费墙**：本模块只做「可配、可保存」，
 *    不在此判套餐（与 Tables 页同一约定）。
 */

import prisma from "../db.server";
import { hasFeature } from "../plan";
import {
    OUT_OF_STOCK_MODES,
    TAX_DISPLAYS,
    normalizeBrandColor,
    normalizeDensity,
    normalizeFeedbackStyle,
    normalizeFont,
    normalizeRadius,
    sanitizeSelector,
    toShopStyleContract,
    type FeedbackStyle,
    type GraphqlAdmin,
    type ShopStyleContract,
} from "./metafield.server";
import { getProductRefsByIds, resolvePlan, TablelyError } from "./tables.server";
import {
    ensureShopSettings,
    pushShopSettingsMetafield,
} from "./settings.server";

export { isTablelyError } from "./tables.server";

/** 两个外观契约是否不同（Free 只能保存「未被改动」的现值，§1.6 降级只锁编辑） */
function styleChanged(a: ShopStyleContract, b: ShopStyleContract): boolean {
    return (
        a.brandColor !== b.brandColor ||
        a.radius !== b.radius ||
        a.density !== b.density ||
        a.font !== b.font
    );
}

export type TaxDisplayChoice = (typeof TAX_DISPLAYS)[number];
export type OutOfStockChoice = (typeof OUT_OF_STOCK_MODES)[number];

/** Design 页当前配置（DB 现状；脏值已归一化，可直接回填表单） */
export type DesignSettings = {
    style: ShopStyleContract;
    taxDisplay: TaxDisplayChoice;
    outOfStock: OutOfStockChoice;
    feedbackStyle: FeedbackStyle;
    hideNative: boolean;
    /** 自定义选择器（未设置返回 `""`，表单显示为空 = 用内置） */
    nativeSelector: string;
};

/** 保存 Design 的原始输入（由路由从 formData 解析；保持纯对象便于单测） */
export type DesignSettingsInput = {
    brandColor?: string | null;
    radius?: string | number | null;
    density?: string | null;
    font?: string | null;
    taxDisplay?: string | null;
    outOfStock?: string | null;
    feedbackStyle?: string | null;
    hideNative?: boolean;
    nativeSelector?: string | null;
};

/** 白名单取一（与 metafield.server 的 `pick` 同口径；此处只需字符串枚举） */
function pickOne<T extends string>(
    allowed: readonly T[],
    value: unknown,
    fallback: T,
): T {
    return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 读取 Design 设置（不存在时**建立默认行**，与安装播种一致，不覆盖已有值） */
export async function getDesignSettings(shop: string): Promise<DesignSettings> {
    const row = await ensureShopSettings(shop);
    const selector = (row.nativeSelector ?? "").trim();
    return {
        style: toShopStyleContract(row.theme),
        taxDisplay: pickOne(TAX_DISPLAYS, row.taxDisplay, "incl"),
        outOfStock: pickOne(OUT_OF_STOCK_MODES, row.outOfStockMode, "gray"),
        feedbackStyle: normalizeFeedbackStyle(row.feedbackStyle),
        hideNative: Boolean(row.hideNative),
        // 回填表单时按「商家实际填过的值」显示；内置默认不写进这里
        nativeSelector: selector,
    };
}

/**
 * 保存 Design 设置：归一化 → 写 DB → 下发 Shop 级 metafield。
 *
 * 归一化全部走 `metafield.server` 的纯函数（品牌色 / 圆角 / 密度 / 字体 / 反馈方式 / 选择器消毒），
 * 保证「DB 值」与「契约值」同源，不存在两套标准。
 * metafield 写失败**必须抛错**（§六），由路由回显 `error.metafieldFailed`。
 */
export async function saveDesignSettings(input: {
    admin: GraphqlAdmin;
    shop: string;
    values: DesignSettingsInput;
}): Promise<{ style: ShopStyleContract }> {
    const style: ShopStyleContract = {
        brandColor: normalizeBrandColor(input.values.brandColor),
        radius: normalizeRadius(input.values.radius),
        density: normalizeDensity(input.values.density),
        font: normalizeFont(input.values.font),
    };

    const taxDisplay = pickOne(TAX_DISPLAYS, input.values.taxDisplay, "incl");
    const outOfStock = pickOne(OUT_OF_STOCK_MODES, input.values.outOfStock, "gray");
    const feedbackStyle = normalizeFeedbackStyle(input.values.feedbackStyle);

    const rawSelector = (input.values.nativeSelector ?? "").trim();
    // 留空 = 用内置候选：落 `null`，契约侧 `sanitizeSelector` 会补默认值
    const nativeSelector = rawSelector ? sanitizeSelector(rawSelector) : null;

    // Pro 门控（§19.3 后端拒写）：Free 只能保存**未被改动**的 Pro 现值，
    // 不可再编辑外观（#27）与缺货策略（#13）——降级后保留现值渲染，仅锁编辑。
    const current = await getDesignSettings(input.shop);
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "custom_style") && styleChanged(current.style, style)) {
        throw new TablelyError("error.proRequired");
    }
    if (!hasFeature(plan, "out_of_stock") && outOfStock !== current.outOfStock) {
        throw new TablelyError("error.proRequired");
    }

    await ensureShopSettings(input.shop);
    await prisma.shopSettings.update({
        where: { shop: input.shop },
        data: {
            theme: style as unknown as object,
            taxDisplay,
            outOfStockMode: outOfStock,
            feedbackStyle,
            hideNative: Boolean(input.values.hideNative),
            nativeSelector,
        },
    });

    await pushShopSettingsMetafield({ admin: input.admin, shop: input.shop });
    return { style };
}

/**
 * 「预览影响范围」的落地链接：取**第一个已启用订购表的商品**的店面商品页。
 *
 * ⚠️ 只做「跳到真实店面让商家自己看」，不在这里数 DOM 匹配元素：
 *    嵌入后台是独立 iframe，取不到店面主题 DOM；后台侧无从得知主题结构（§2.8 约束 4
 *    的「元素数量 / 首个匹配摘要」需要店面上下文，本里程碑如实记为局限）。
 *    无已启用商品时返回 `null`，按钮禁用并提示先配置商品。
 */
export async function getPreviewUrl(input: {
    admin: GraphqlAdmin;
    shop: string;
}): Promise<string | null> {
    const row = await prisma.productTable.findFirst({
        where: { shop: input.shop, enabled: true },
        orderBy: [{ sortOrder: "asc" }, { updatedAt: "desc" }],
        select: { productId: true },
    });
    if (!row) return null;
    const refs = await getProductRefsByIds(input.admin, [row.productId]);
    const handle = refs[0]?.handle;
    if (!handle) return null;
    return `https://${input.shop}/products/${encodeURIComponent(handle)}`;
}
