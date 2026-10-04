import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createWebhookOnce } from "../services/security.server";
import { logStructured } from "../services/monitor.server";
import { cleanupShopData } from "../services/uninstall.server";

/**
 * 卸载：app/uninstalled
 *
 * HMAC 校验由 authenticate.webhook 完成，签名无效直接 401（§8.2 C）。
 * 本主题可能被重复投递、也可能在数据已删除后才到达，因此：
 *   ① 用 X-Shopify-Webhook-Id 幂等去重；
 *   ② 删除动作全部按 `shop` 条件执行（删不到也不报错）；
 *   ③ 清理本身是**幂等**的（§8.1），重复执行也只会得到「已无残留」。
 *
 * M8：卸载清理统一走 `cleanupShopData`（§2.2.2 / §十二 验收 10）——
 *   先读标识 → 删 3 个 automatic discount + 主动删 app-owned metafield →
 *   清本店全部业务表。Shopify 可能在卸载时吊销 token，故 Shopify 侧删除是
 *   **尽力而为**，失败只记日志、绝不让 webhook 500（局限见 uninstall.server.ts）。
 */
const once = createWebhookOnce();

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, admin } = await authenticate.webhook(request);

  logStructured("info", "webhooks.app_uninstalled", { shop, topic: String(topic) });

  await once(webhookId, { topic: String(topic), shop }, async () => {
    const result = await cleanupShopData({ shop, admin });
    logStructured("info", "uninstall.cleanup_done", { shop, ...result });
  });

  return new Response();
};
