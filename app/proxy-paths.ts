/**
 * App Proxy 顾客可见路径（M13）—— **客户端安全**
 *
 * 这些常量要同时被**服务端回源路由**与**后台客户端组件**使用（例如 Tables 页展示
 * 「快速补货链接」）。若从 `services/appProxy.server.ts` 导入，会把 server-only 模块
 * 拖进客户端包（React Router 构建报 `Server-only module referenced by client`），
 * 故按 `design-choices.ts` 同法，把纯字符串常量单独放在客户端安全模块里，
 * 再由 `appProxy.server.ts` 重新导出，保证「一处定义、两处引用」。
 */

/** 店铺同域的回源前缀（`[app_proxy]` 的 `subpath` + `prefix`，§15.2） */
export const PROXY_SUBPATH = "/apps/tablely";

/** 申请表单的顾客可见地址：`https://<shop>/apps/tablely/apply` */
export const APPLY_PATH = `${PROXY_SUBPATH}/apply`;

/** 快速补货落脚页（M13 / §15.4）：`https://<shop>/apps/tablely/quick-order` */
export const QUICK_ORDER_PATH = `${PROXY_SUBPATH}/quick-order`;

/** 历史加购预填接口（M13 / Y15 / §15.7）：`https://<shop>/apps/tablely/history` */
export const HISTORY_PATH = `${PROXY_SUBPATH}/history`;

/** 报价单打印视图（M13 / Y17 / §15.8）：`https://<shop>/apps/tablely/quote` */
export const QUOTE_PATH = `${PROXY_SUBPATH}/quote`;