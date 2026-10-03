import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { createWebhookOnce } from "../services/security.server";

/**
 * 卸载：app/uninstalled
 *
 * HMAC 校验由 authenticate.webhook 完成，签名无效直接 401（§8.2 C）。
 * 本主题可能被重复投递、也可能在数据已删除后才到达，因此：
 *   ① 用 X-Shopify-Webhook-Id 幂等去重；
 *   ② 删除动作全部按 `shop` 条件执行（删不到也不报错）。
 *
 * M2 起还需清 Shop / 业务表；app-owned metafield 由 Shopify 在卸载时自动清除，
 * 但 §2.2 要求「卸载后主动删除 3 个 automatic discount」，那部分在 M8/M15 补。
 */
const once = createWebhookOnce();

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await once(webhookId, { topic: String(topic), shop }, async () => {
    await db.session.deleteMany({ where: { shop } });
  });

  return new Response();
};