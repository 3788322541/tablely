import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  assertShopOwnership,
  constantTimeEqual,
  createWebhookOnce,
  hmacSha256Base64,
  verifyWebhookHmac,
  type WebhookDedupStore,
} from "./security.server";

const SECRET = "shpss_test_secret";
const BODY = '{"id":123,"topic":"shop/redact"}';

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verifyWebhookHmac（正反两向）", () => {
  it("正向：签名正确时通过", () => {
    expect(verifyWebhookHmac(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("正向：Buffer 形式的 raw body 与字符串等价", () => {
    expect(verifyWebhookHmac(Buffer.from(BODY, "utf8"), sign(BODY), SECRET)).toBe(
      true,
    );
  });

  it("反向：body 被篡改后拒绝", () => {
    expect(verifyWebhookHmac(`${BODY} `, sign(BODY), SECRET)).toBe(false);
  });

  it("反向：密钥不符时拒绝", () => {
    expect(verifyWebhookHmac(BODY, sign(BODY, "shpss_other"), SECRET)).toBe(
      false,
    );
  });

  it("反向：缺失 / 空签名头拒绝", () => {
    expect(verifyWebhookHmac(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookHmac(BODY, "", SECRET)).toBe(false);
    expect(verifyWebhookHmac(BODY, undefined, SECRET)).toBe(false);
  });

  it("反向：长度不同的签名不抛错、只返回 false", () => {
    expect(verifyWebhookHmac(BODY, sign(BODY).slice(0, 20), SECRET)).toBe(false);
  });

  it("反向：secret 为空时拒绝（不把空密钥当有效密钥）", () => {
    expect(verifyWebhookHmac(BODY, sign(BODY, ""), "")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("相同字符串为 true，不同内容为 false", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("长度不同不抛错", () => {
    expect(constantTimeEqual("abc", "abcdef")).toBe(false);
  });
});

describe("hmacSha256Base64", () => {
  it("与 Node crypto 结果一致（base64）", () => {
    expect(hmacSha256Base64(BODY, SECRET)).toBe(sign(BODY));
  });
});

class MemoryDedupStore implements WebhookDedupStore {
  private seen = new Set<string>();

  async claim(webhookId: string): Promise<boolean> {
    if (this.seen.has(webhookId)) return false;
    this.seen.add(webhookId);
    return true;
  }
}

describe("webhook 幂等去重", () => {
  it("同一 X-Shopify-Webhook-Id 重复投递只执行一次", async () => {
    const once = createWebhookOnce(new MemoryDedupStore());
    const run = vi.fn(async () => {});

    await expect(
      once("wh_1", { topic: "SHOP_REDACT", shop: "a.myshopify.com" }, run),
    ).resolves.toBe(true);
    await expect(
      once("wh_1", { topic: "SHOP_REDACT", shop: "a.myshopify.com" }, run),
    ).resolves.toBe(false);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("不同投递 id 各执行一次", async () => {
    const once = createWebhookOnce(new MemoryDedupStore());
    const run = vi.fn(async () => {});

    await once("wh_1", { topic: "SHOP_REDACT", shop: "a" }, run);
    await once("wh_2", { topic: "SHOP_REDACT", shop: "a" }, run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("缺少投递 id 时抛错（不静默跳过，避免掩盖配置问题）", async () => {
    const once = createWebhookOnce(new MemoryDedupStore());
    await expect(
      once("", { topic: "SHOP_REDACT", shop: "a" }, async () => {}),
    ).rejects.toThrow(/X-Shopify-Webhook-Id/);
  });
});

describe("跨店 id 越权访问被拒（§8.2 A）", () => {
  const row = { id: "rule_1", shop: "a.myshopify.com" };

  it("同店：返回该行", () => {
    expect(assertShopOwnership(row, "a.myshopify.com")).toBe(row);
  });

  it("跨店：抛 404，不泄露资源是否存在", () => {
    try {
      assertShopOwnership(row, "b.myshopify.com");
      expect.unreachable("跨店访问必须被拒");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(404);
    }
  });

  it("不存在：同样抛 404", () => {
    expect(() => assertShopOwnership(null, "a.myshopify.com")).toThrow(
      Response,
    );
  });
});