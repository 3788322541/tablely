import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createWebhookOnce } from "../services/security.server";
import { logStructured } from "../services/monitor.server";
import { cleanupShopData } from "../services/uninstall.server";

/**
 * 强制合规 webhook（一个路由处理 3 个主题：customers/data_request · customers/redact · shop/redact）
 *
 * HMAC 校验由 authenticate.webhook 完成，签名无效时 SDK 直接返回 401（§8.2 C）。
 * 重复投递由 X-Shopify-Webhook-Id 幂等去重；既要保证 shop/redact 重复调用不报错，
 * 也要保证重放时不会重复执行清理（§8.1）。
 *
 * 数据保留范围以 §8.1 总表为唯一权威。`shop/redact`（卸载后 48h 送达，此时
 * access token 多半已吊销）统一走 `cleanupShopData`：无 admin 时只清 DB，
 * 与 `app/uninstalled` 共用同一套幂等清理（M8 / §十二 验收 10）。
 *
 * 日志（Y7 / §21.5）：只记主题与店铺，**不打印 payload**（data_request 的 payload 含顾客 PII）。
 */
const once = createWebhookOnce();

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, webhookId, admin } = await authenticate.webhook(request);

  // 注意：authenticate.webhook 把 HTTP 头里的主题名归一化成了大写枚举，
  // shop/redact 到这里已是 "SHOP_REDACT"，不能按原始小写斜杠形式比较。
  const normalized = String(topic).toLowerCase();

  await once(webhookId, { topic: String(topic), shop }, async () => {
    logStructured("info", "webhooks.compliance_received", {
      shop,
      topic: String(topic),
    });

    if (normalized === "shop_redact") {
      const result = await cleanupShopData({ shop, admin });
      logStructured("info", "uninstall.cleanup_done", { shop, ...result });
    }
    // customers/data_request 与 customers/redact：本应用不存顾客个人信息
    // （零 PCD，§2.4），故无个人数据可返回 / 可删，记录日志后即视为完成。
  });

  return new Response();
};