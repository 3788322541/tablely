/**
 * Webhook 鉴权兜底（部署规范 §10.2）
 *
 * 背景：`authenticate.webhook` 在「离线令牌临期 → 主动续期」失败时，
 * SDK 内部（`@shopify/shopify-app-react-router` 的 `helpers/refresh-token.mjs`）
 * 会**硬编码** `throw new Response(undefined, { status: 500 })`，且不打印任何日志。
 * 后果：handler 完全不执行，Shopify 按指数退避反复重投（`app/uninstalled` 与
 * 合规 webhook 更会重投到最终放弃），卸载 / 合规清理全部落空。
 *
 * 这里在路由入口包一层：
 *   1. **只**兜底 SDK 抛出的 5xx —— 400 / 401 / 405 一律原样抛出，鉴权语义不变；
 *   2. 再独立复核一次 HMAC —— 500 一定发生在 SDK 的 HMAC 校验**之后**，
 *      复核是为让兜底自身成立、不依赖 SDK 内部调用顺序；
 *   3. 复核通过才降级处理：直接读库里那份离线会话（不续期、不校验过期），
 *      `admin` 刻意留空（token 已过期，Admin API 不可用），交给 handler 走纯 DB 路径
 *      （`cleanupShopData` 已按「无 admin 只清 DB」实现，§2.2.2）。
 *
 * 安全边界：兜底分支必经 HMAC 复核，伪造请求拿不到 200。
 */
import { authenticate, sessionStorage } from "../shopify.server";
import { verifyWebhookHmac } from "./security.server";

type WebhookContext = Awaited<ReturnType<typeof authenticate.webhook>>;
type OfflineSession = NonNullable<WebhookContext["session"]>;

const HMAC_HEADER = "x-shopify-hmac-sha256";
const TOPIC_HEADER = "x-shopify-topic";
const DOMAIN_HEADER = "x-shopify-shop-domain";
const API_VERSION_HEADER = "x-shopify-api-version";
const WEBHOOK_ID_HEADER = "x-shopify-webhook-id";

/** 读取该店铺的离线会话；忽略过期，只为让 handler 拿到 session.id 之类的字段 */
async function loadOfflineSession(shop: string): Promise<OfflineSession | undefined> {
    try {
        const sessions = await sessionStorage.findSessionsByShop?.(shop);
        return sessions?.find((session) => !session.isOnline);
    } catch (error) {
        console.error("[webhook] 兜底读取离线会话失败：", error);
        return undefined;
    }
}

export async function authenticateWebhookResilient(request: Request): Promise<WebhookContext> {
    // SDK 会消费原始 body，先克隆一份留给兜底分支
    const rawBody = await request.clone().text();

    try {
        return await authenticate.webhook(request);
    } catch (error) {
        if (!(error instanceof Response) || error.status < 500) throw error;
        if (
            !verifyWebhookHmac(
                rawBody,
                request.headers.get(HMAC_HEADER),
                process.env.SHOPIFY_API_SECRET ?? "",
            )
        ) {
            throw error;
        }

        const shop = request.headers.get(DOMAIN_HEADER) ?? "";
        const topicHeader = request.headers.get(TOPIC_HEADER) ?? "";
        const offlineSession = shop ? await loadOfflineSession(shop) : undefined;

        console.error(
            `[webhook] 离线令牌续期失败，降级处理（无 admin）：${topicHeader} ${shop}`,
        );

        const context = {
            apiVersion: request.headers.get(API_VERSION_HEADER) ?? "",
            shop,
            // 与 SDK 的 topicForStorage 保持一致：大写 + 斜杠/点转下划线
            topic: topicHeader.toUpperCase().replace(/\/|\./g, "_"),
            webhookId: request.headers.get(WEBHOOK_ID_HEADER) ?? "",
            payload: JSON.parse(rawBody),
            subTopic: undefined,
            session: offlineSession,
            admin: undefined,
            webhookType: "webhooks",
        };
        // 有会话但 admin 刻意留空，与 SDK 的 WebhookContext 联合类型不符，故此处收窄
        return context as unknown as WebhookContext;
    }
}