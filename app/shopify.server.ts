import "@shopify/shopify-app-react-router/adapters/node";
import {
    ApiVersion,
    AppDistribution,
    shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureTablelySetup } from "./services/settings.server";

/**
 * Shopify 应用初始化（M1 脚手架）
 *
 * `afterAuth`（仅离线授权）做**安装播种**：建两份 metafield 定义（店面可见性）
 * → 建 ShopSettings 默认行（已存在不覆盖）→ 下发 `tablely.settings`（§2.7 契约 v2）。
 * 失败不阻塞认证：Overview 的 loader 会在每次进入后台时重跑同一套幂等自愈
 * （`ensureTablelySetup`），商家无需重装。
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
    hooks: {
        afterAuth: async ({ session, admin }) => {
            if (session.isOnline) return;
            try {
                await ensureTablelySetup({ admin, shop: session.shop });
            } catch (error) {
                console.error("[tablely] afterAuth 安装播种失败:", error);
            }
        },
    },
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