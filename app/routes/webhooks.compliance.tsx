import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { createWebhookOnce } from "../services/security.server";
import { logStructured } from "../services/monitor.server";
import { cleanupShopData } from "../services/uninstall.server";
import {
    redactApplicationsByCustomer,
    summarizeApplicationsForCustomer,
} from "../services/applications.server";

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
 * 数据范围（M11 起更新，§8.1 / §15.3）：应用**不存订单 / 地址 / 支付信息**（零 PCD），
 * 但**申请表单会存商家主动收集的 B2B 联络字段**（姓名 / 邮箱 / 电话 / 公司，§15.1）。
 * 因此：`customers/redact` 必须**删除**该顾客的申请行；`customers/data_request` 返回其申请摘要。
 * 其余业务数据无顾客标识，随 `shop/redact` / 卸载全量清理。
 *
 * 日志（Y7 / §21.5）：只记主题、店铺与条数，**不打印 payload / 邮箱**（含顾客 PII）。
 */
const once = createWebhookOnce();

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, webhookId, admin, payload } = await authenticate.webhook(request);

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

    // 顾客级合规：申请行含 B2B 联络字段（§15.1），必须能按顾客定位与删除
    if (normalized === "customers_redact" || normalized === "customers_data_request") {
      const customer = (payload as { customer?: { id?: number | string; email?: string } })
        ?.customer;
      const email = customer?.email ?? null;
      const customerId = customer?.id != null ? String(customer.id) : null;

      if (normalized === "customers_redact") {
        const deleted = await redactApplicationsByCustomer({ shop, email, customerId });
        logStructured("info", "applications.redacted", { shop, deleted });
      } else {
        const rows = await summarizeApplicationsForCustomer({ shop, email, customerId });
        logStructured("info", "applications.data_request", { shop, count: rows.length });
      }
    }
  });

  return new Response();
};