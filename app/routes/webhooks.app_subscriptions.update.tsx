import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { createWebhookOnce } from "../services/security.server";
import { applySubscriptionWebhook } from "../services/billing.server";
import { logStructured } from "../services/monitor.server";
import type { GraphqlAdmin } from "../services/metafield.server";

/**
 * 订阅状态变更：app_subscriptions/update（M9）
 *
 * HMAC 校验由 `authenticate.webhook` 完成，签名无效直接 401。
 * 本路由把 payload 交给 `applySubscriptionWebhook` 回写 `PlanState.plan`，
 * 并在档位变化时同步 3 个 automatic discount 的启停（§2.2.2 / §19.3 降级温和策略）。
 *
 * 离线会话用于拿 Admin API 删/停折扣；**取不到时不阻塞**（DB 侧仍回写，
 * 每日兜底同步与 `shop/redact` 会补 Shopify 侧动作）。
 *
 * 写库失败要返回 500 让 Shopify 按重试策略重投——档位不一致会导致
 * 「付了钱还是 Free」这种最伤商家的故障，静默吞掉更危险。
 */
const once = createWebhookOnce();

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  await once(webhookId, { topic: String(topic), shop }, async () => {
    let admin: GraphqlAdmin | null = null;
    try {
      const result = await unauthenticated.admin(shop);
      admin = result.admin;
    } catch (error) {
      logStructured("warn", "billing.webhook_no_admin", {
        shop,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const plan = await applySubscriptionWebhook(shop, payload, admin);
    logStructured("info", "billing.webhook_applied", { shop, plan });
  });

  return new Response();
};