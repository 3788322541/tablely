/**
 * Design 页的可展示选项（M8）—— **客户端安全**（零 server-only 依赖）
 *
 * 为什么单独一份：`app/services/metafield.server.ts` 是 server-only 模块（依赖 db.server），
 * 而 React Router 只从路由里剥离 `loader` / `action` / `headers` / `middleware`；
 * 组件里引用的模块会进客户端包，直接 import 会触发
 * 「Server-only module referenced by client」构建错误（M8 实测）。
 *
 * 这些取值仍是**唯一真源**：`metafield.server` 从这里 import 并再导出，
 * 服务端归一化与后台下拉共用同一份白名单，不存在两套标准（§20.2 文案同理）。
 */

/** 含税显示（`incl` / `excl`，§五 taxDisplay） */
export const TAX_DISPLAYS = ["incl", "excl"] as const;

/** 缺货策略（§五 outOfStock；`hide` / `backorder` 的实现在 M7） */
export const OUT_OF_STOCK_MODES = ["gray", "hide", "backorder"] as const;

/** B1 隐藏主题自带加购区的内置选择器（商家可在 Design 页覆写，M8） */
export const DEFAULT_NATIVE_SELECTOR = 'form[action*="/cart/add"]';
/** B1 内置候选选择器（Design 页下拉给商家挑；常见的主题加购容器） */
export const NATIVE_SELECTOR_CANDIDATES = [
    DEFAULT_NATIVE_SELECTOR,
    ".product-form__buttons",
    ".product-form__item--submit",
    "[name='add']",
] as const;

/** 外观-密度（§六 Design 外观；影响表格内边距） */
export const DENSITIES = ["compact", "default", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];
/** 外观-字体（`inherit` = 跟随主题，是默认且最兼容的取值） */
export const FONTS = ["inherit", "system", "serif"] as const;
export type FontChoice = (typeof FONTS)[number];
/** 反馈呈现方式（M8；`inline` 行内 / `toast` 浮层 / `both` 两者） */
export const FEEDBACK_STYLES = ["inline", "toast", "both"] as const;
export type FeedbackStyle = (typeof FEEDBACK_STYLES)[number];
/** 圆角可调范围（px）；0 也是合法值（直角） */
export const RADIUS_MIN = 0;
export const RADIUS_MAX = 24;

/** 外观样式契约（§五；全部可选，`null` = 跟随主题 / 用默认） */
export type ShopStyleContract = {
    /** 品牌色 `#rrggbb`；`null` = 从 `currentColor` 派生（最兼容） */
    brandColor: string | null;
    /** 圆角 px（0–24）；`null` = 默认值 */
    radius: number | null;
    density: Density;
    font: FontChoice;
};

/** 供 Design 页渲染下拉选项（单一来源，避免路由里再抄一份白名单） */
export const DESIGN_CHOICES = {
    densities: DENSITIES,
    fonts: FONTS,
    feedbackStyles: FEEDBACK_STYLES,
    taxDisplays: TAX_DISPLAYS,
    outOfStockModes: OUT_OF_STOCK_MODES,
} as const;
