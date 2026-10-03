import "@shopify/shopify-app-react-router/adapters/node";
import {
    ApiVersion,
    AppDistribution,
    shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

/**
 * Shopify 应用初始化（M1 脚手架）
 *
 * M1 只做最小可用：会话存储 + 内嵌后台 + OAuth。
 * M2 起在这里挂 `hooks.afterAuth`：建 Shop 行、播种默认设置、
 * 下发 Shop 级 app-data metafield（namespace `tablely` / key `settings`，§2.7 契约）。
 *
 * 约定（§8.2 A）：业务代码里的 `shop` 一律取自 `session`（Admin 路由）
 * 或 Shopify 签名参数（App Proxy），严禁取自请求体 / query。
 */
const shopify = shopifyApp({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
    apiVersion: ApiVersion.July26,
    scopes: process.env.SCOPES?.split(","),
    appUrl: process.env.SHOPIFY_APP_URL || "",
    authPathPrefix: "/auth",
    sessionStorage: new PrismaSessionStorage(prisma),
    distribution: AppDistribution.AppStore,
    future: {
        expiringOfflineAccessTokens: true,
    },
    ...(process.env.SHOP_CUSTOM_DOMAIN
        ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
        : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;