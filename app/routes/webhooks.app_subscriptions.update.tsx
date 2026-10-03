import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createWebhookOnce } from "../services/security.server";

/**
 * 订阅状态变更：app_subscriptions/update（M9 实现回写）
 *
 * HMAC 校验由 authenticate.webhook 完成，签名无效直接 401。
 * M9 起在这里回写 Shop.plan + Subscription 快照，并保持「降级不破坏店面」的
 * 温和策略（超限只锁新增/编辑，不下线店面表格、不删 metafield，方案 §1.6/§7）。
 *
 * 写库失败要返回 500 让 Shopify 按重试策略重投——档位不一致会导致
 * 「付了钱还是 Free」这种最伤商家的故障，静默吞掉更危险。
 */
const once = createWebhookOnce();

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);

  await once(webhookId, { topic: String(topic), shop }, async () => {
    console.log(`[tablely] ${topic} → ${shop}（档位回写见 M9）`);
  });

  return new Response();
};