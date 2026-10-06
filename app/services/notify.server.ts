import { createHmac } from "node:crypto";
import { logStructured } from "./monitor.server";

/**
 * 开发者告警出口（§21.5）
 *
 * 折扣完整性每日巡检（`api.internal.discount-integrity`）发现问题时，把报告推到
 * **飞书群自定义机器人**。告警**只发开发者自己**，绝不发给商家（与 Y4 / §21.5 一致）。
 *
 * 与宿主机 `scripts/alert.mjs` 的关系：
 *   - 两者读**同一组** `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_SECRET`；
 *   - 但运行位置不同：`alert.mjs` 在宿主机（可用性 / 磁盘 / 容器），本模块在应用容器内
 *     （业务完整性 —— 需要 Admin API 与 DB，宿主机脚本拿不到）。
 *   - 因此签名算法必须与 `alert.mjs` 的 `feishuSign` **保持同口径**，改动要同步两侧。
 */

/** 告警级别，与 `monitor.server.ts` 的 `IntegrityIssue.severity` 同口径 */
export type AlertSeverity = "P1" | "P2";

/**
 * 飞书自定义机器人签名。
 *
 * ⚠️ **算法反直觉**（2026-10-06 实测踩过）：`key = "${timestamp}\n${secret}"`、
 * **消息体为空**，再取 `base64(HMAC-SHA256)`。
 * 写成常规的 `key=secret` / `msg=timestamp+secret` 会得到 **HTTP 200 但 body
 * `code: 19021 sign match fail`**。
 * 另：`timestamp` 与飞书服务器时差需在 **1 小时**内。
 */
export function feishuSign(secret: string, timestamp: string): string {
    return createHmac("sha256", `${timestamp}\n${secret}`)
        .update("")
        .digest("base64");
}

function isFeishuWebhook(url: string): boolean {
    return /open\.feishu\.cn|open\.larksuite\.com/.test(url);
}

export interface NotifyResult {
    /** 是否确认送达 */
    delivered: boolean;
    /** 未配置 `ALERT_WEBHOOK_URL` 时为 true —— 区分「没发」与「发失败」 */
    skipped: boolean;
}

/**
 * 推送一条纯文本告警到开发者告警通道。
 *
 * 兼容两类出口：飞书自定义机器人（走签名 + `msg_type/content`），
 * 其余（Telegram / 邮件网关等）直接 POST `{ text }` —— 与 `scripts/alert.mjs` 同口径。
 *
 * ⚠️ 飞书**成功与失败都可能返 HTTP 200**，必须读 body 的 `code === 0` 才算真发出。
 * 任何失败都**只记日志、不抛错** —— 每日巡检不能因为告警通道故障而整体失败。
 */
export async function notifyDeveloper(text: string): Promise<NotifyResult> {
    const webhook = process.env.ALERT_WEBHOOK_URL;
    if (!webhook) {
        logStructured("warn", "notify.skipped", {
            reason: "ALERT_WEBHOOK_URL 未配置",
        });
        return { delivered: false, skipped: true };
    }

    const feishu = isFeishuWebhook(webhook);
    const secret = process.env.ALERT_WEBHOOK_SECRET;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = feishu
        ? {
              ...(secret ? { timestamp, sign: feishuSign(secret, timestamp) } : {}),
              msg_type: "text",
              content: { text },
          }
        : { text };

    try {
        const response = await fetch(webhook, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (feishu) {
            const body = (await response.json().catch(() => null)) as {
                code?: unknown;
            } | null;
            if (response.ok && body?.code === 0) {
                return { delivered: true, skipped: false };
            }
            logStructured("error", "notify.failed", {
                status: response.status,
                code: body?.code,
            });
            return { delivered: false, skipped: false };
        }

        if (response.ok) return { delivered: true, skipped: false };
        logStructured("error", "notify.failed", { status: response.status });
        return { delivered: false, skipped: false };
    } catch (error) {
        logStructured("error", "notify.failed", {
            reason: error instanceof Error ? error.message : String(error),
        });
        return { delivered: false, skipped: false };
    }
}

/** 把巡检问题列表排版成一条可读的告警文本（按 P1 → P2、店铺分组） */
export function formatIntegrityReport(
    issues: { shop: string; code: string; severity: AlertSeverity; detail: string }[],
    shopsChecked: number,
): string {
    const p1 = issues.filter((issue) => issue.severity === "P1");
    const p2 = issues.filter((issue) => issue.severity === "P2");
    const head = `[Tablely] 折扣完整性巡检发现 ${issues.length} 个问题（P1 ${p1.length} / P2 ${p2.length}），已检查 ${shopsChecked} 个店铺`;

    const lines: string[] = [];
    for (const [label, group] of [
        ["P1 立即处理", p1],
        ["P2 工作日处理", p2],
    ] as const) {
        if (!group.length) continue;
        lines.push("", `${label}（${group.length}）`);
        for (const issue of group) {
            lines.push(`- ${issue.shop} | ${issue.code} | ${issue.detail}`);
        }
    }

    return [head, ...lines].join("\n");
}