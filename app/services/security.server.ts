import { createHmac, timingSafeEqual } from "node:crypto";
import db from "../db.server";

/**
 * 安全骨架（Y8，§8.2）
 *
 * 本文件只放「提审红线」相关的公共原语，业务逻辑不放这里：
 *   ① HMAC-SHA256 常量时间比较 —— webhook 与 App Proxy 签名校验共用
 *   ② webhook 幂等去重 —— 以 X-Shopify-Webhook-Id 为键，重复投递只执行一次
 *   ③ 租户隔离断言 —— 每一次按 id 的读写都必须同时带 shop 条件（§8.2 A）
 *
 * 约定：`shop` 一律取自 session（Admin 路由）或 Shopify 签名参数（App Proxy），
 * **严禁**取自请求体 / query（§8.2 A）。
 */

/* ------------------------------------------------------------------ *
 * ① HMAC（常量时间比较）
 * ------------------------------------------------------------------ */

/** 计算 HMAC-SHA256（base64），用于 webhook 与 App Proxy 的签名校验 */
export function hmacSha256Base64(
  rawBody: string | Buffer,
  secret: string,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

/**
 * 常量时间比较两段字符串（避免时序侧信道，§8.2 C）。
 *
 * `crypto.timingSafeEqual` 要求两个 Buffer 等长，否则直接抛错；
 * 而长度本身就会泄露信息，所以先比长度、不等立即返回 false。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 校验 Shopify webhook 的 HMAC（`X-Shopify-Hmac-Sha256`，对 **raw body** 计算）。
 * 正反两向都由本函数判定：签名正确返回 true，缺失 / 篡改 / 密钥不符均返回 false。
 */
export function verifyWebhookHmac(
  rawBody: string | Buffer,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!hmacHeader || !secret) return false;
  return constantTimeEqual(hmacSha256Base64(rawBody, secret), hmacHeader);
}

/* ------------------------------------------------------------------ *
 * ② webhook 幂等去重（§8.1 / §8.2 C）
 * ------------------------------------------------------------------ */

export interface WebhookDeliveryMeta {
  /** 归一化后的主题名（如 SHOP_REDACT） */
  topic: string;
  shop: string;
}

export interface WebhookDedupStore {
  /** 尝试占用该投递 id：首次占用返回 true，重复投递返回 false */
  claim(webhookId: string, meta: WebhookDeliveryMeta): Promise<boolean>;
}

/** Prisma 唯一键冲突（P2002）判定，不依赖具体错误类，便于跨版本稳定 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** 生产实现：靠 WebhookEvent 主键冲突原子判重（并发投递也只会有一个成功） */
export const prismaWebhookDedupStore: WebhookDedupStore = {
  async claim(webhookId, meta) {
    try {
      await db.webhookEvent.create({
        data: { id: webhookId, topic: meta.topic, shop: meta.shop },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  },
};

/**
 * 包一层「同一投递只执行一次」。返回 true 表示本次执行了 `run`，
 * false 表示是重复投递、已跳过（调用方两种情况都应返回 200，避免 Shopify 重试）。
 */
export function createWebhookOnce(
  store: WebhookDedupStore = prismaWebhookDedupStore,
) {
  return async function once(
    webhookId: string,
    meta: WebhookDeliveryMeta,
    run: () => Promise<void>,
  ): Promise<boolean> {
    if (!webhookId) {
      throw new Error(
        "webhook 缺少 X-Shopify-Webhook-Id，无法保证幂等（§8.2 C）",
      );
    }
    if (!(await store.claim(webhookId, meta))) return false;
    await run();
    return true;
  };
}

/* ------------------------------------------------------------------ *
 * ③ 租户隔离（§8.2 A）
 * ------------------------------------------------------------------ */

export interface ShopOwned {
  shop: string;
}

/**
 * 跨店访问一律按「不存在」处理：返回 404 而不是 403，
 * 不向调用方泄露「该 id 在别的店里存在」这一事实。
 */
export function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/**
 * 断言一行数据属于当前店铺；不属于（或不存在）直接抛 404。
 *
 * 用法：`const rule = assertShopOwnership(await db.rule.findUnique(...), session.shop)`
 * 注意查询本身也应带 `shop` 条件（`where: { id, shop }`），本函数是第二道闸。
 */
export function assertShopOwnership<T extends ShopOwned>(
  row: T | null | undefined,
  shop: string,
): T {
  if (!row || row.shop !== shop) throw notFound();
  return row;
}