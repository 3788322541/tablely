/**
 * 客户可见的支持信息（客户端安全常量模块）
 *
 * ⚠️ 本文件**不得** import 任何 `*.server` 模块 —— 它同时被公开的 `/privacy`
 * 与后台 Help 页引用（贡献者约定见 `app/proxy-paths.ts` / `app/design-choices.ts`）。
 *
 * 支持邮箱三处保持一致：Listing 的 Support email、隐私页模块 6、Help 页底部
 * （§8.3 / §1.4 #31）。
 */
export const SUPPORT_EMAIL = "junitzhen@gmail.com";

/**
 * 隐私页「最后更新」日期。
 *
 * 硬要求（§8.3）：**改 §8.1 数据保留总表必须同 PR 改隐私页**，
 * 并同时把这个日期往后推 —— 它就是「隐私页与总表是否同步」的可见凭证。
 */
export const PRIVACY_UPDATED_AT = "2026-10-06";
