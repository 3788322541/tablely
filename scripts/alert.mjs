#!/usr/bin/env node
/**
 * Tablely 探针 + 告警（§21.5「容器健康检查 + 结构化日志 + 一个免费外部探针」）
 *
 * 接入方式（§21.5）：**服务器上的 crontab** 每 5 分钟调一次 ——
 *   cd /srv/tablely && set -a && . /srv/tablely/.alert.env && set +a && node scripts/alert.mjs
 * ⚠️ 宿主需有 `node`（服务器上装在 `/usr/local/bin/node`，v20 LTS 手动解包安装）；
 *    `ALERT_WEBHOOK_URL` 放在 `/srv/tablely/.alert.env`（600 权限）**而不是 crontab 明文里**。
 *
 * 三条纪律（§21.5）：
 *   · **告警只发给开发者自己**（飞书群机器人 / 邮箱 / Telegram），绝不发给商家 —— 本脚本只认 `ALERT_WEBHOOK_URL`；
 *   · **分级**：P1 = 店面不可用（连续 2 次健康检查失败 / 容器非 healthy / 磁盘 > 80%），
 *     P2 = 单次抖动等非致命项；
 *   · **降噪**：同类告警 **30 分钟内只发一次**（按 key 去重），恢复时补一条「已恢复」。
 *
 * 环境变量：
 *   TABLELY_HEALTH_URL      默认 https://tablely.zhenjunit.com/healthz
 *   TABLELY_APP_DIR         默认 /srv/tablely（用于磁盘水位与 docker compose ps）
 *   ALERT_WEBHOOK_URL       告警出口（飞书群自定义机器人 / Telegram Bot / 邮件网关的入站 webhook）；
 *                           按 URL 自动选格式（飞书需 `msg_type` 包裹）；未配置则只打印
 *   ALERT_STATE_FILE        去重与连续失败计数的状态文件，默认 <APP_DIR>/.deploy/alert-state.json
 *   ALERT_QUIET_MINUTES     同类告警静默窗口，默认 30
 *   ALERT_DISK_MAX_PERCENT  磁盘水位阈值，默认 80
 *
 * 不做：付费 APM、分布式追踪、面向商家的状态页（§21.5「明确不做」）。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const HEALTH_URL =
    process.env.TABLELY_HEALTH_URL ?? "https://tablely.zhenjunit.com/healthz";
const APP_DIR = process.env.TABLELY_APP_DIR ?? "/srv/tablely";
const STATE_FILE =
    process.env.ALERT_STATE_FILE ?? `${APP_DIR}/.deploy/alert-state.json`;
const QUIET_MS =
    Number(process.env.ALERT_QUIET_MINUTES ?? 30) * 60 * 1000;
const DISK_MAX = Number(process.env.ALERT_DISK_MAX_PERCENT ?? 80);
/** 连续失败次数达到该值才升级为 P1（§21.5 可用性层：连续 2 次失败 → P1） */
const HEALTH_FAILS_FOR_P1 = 2;

/**
 * 严重度排序：**升级时必须立即补发**。
 * ⚠️ 若把降噪窗口无条件套在升级上，「连续 2 次失败 → P1」就会形同虚设：
 * 第 1 次失败已发过 P2 并写了 `sent[key]`，第 2 次的 P1 会被判为「30 分钟内重复」而静默 ——
 * 开发者只收到 P2，永远等不到 P1（实测复现过）。故**升级突破降噪**。
 */
const SEVERITY_RANK = { P1: 2, P2: 1 };
const rankOf = (severity) => SEVERITY_RANK[severity] ?? 0;

/* ------------------------------------------------------------------ *
 * 状态：去重时间戳 + 健康检查连续失败次数
 * ------------------------------------------------------------------ */

async function loadState() {
    try {
        return JSON.parse(await readFile(STATE_FILE, "utf8"));
    } catch {
        return { sent: {}, healthFails: 0, active: {} };
    }
}

async function saveState(state) {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ *
 * 探针（只读，不触发任何写操作）
 * ------------------------------------------------------------------ */

/** 可用性：`/healthz` 必须 200 且 `status: "ok"`（DB 不通时路由会返回非 ok） */
async function probeHealth() {
    try {
        const response = await fetch(HEALTH_URL, {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            return { ok: false, detail: `HTTP ${response.status}` };
        }
        const body = await response.json();
        if (body?.status !== "ok") {
            return { ok: false, detail: `status=${body?.status} db=${body?.db}` };
        }
        return { ok: true, detail: `version=${body?.version}` };
    } catch (error) {
        return { ok: false, detail: `请求失败：${error?.message ?? error}` };
    }
}

/** 资源：磁盘水位（共享 edge 层会影响同机所有应用，故阈值单独设） */
async function probeDisk() {
    try {
        const { stdout } = await run("df", ["-Pk", APP_DIR]);
        const line = stdout.trim().split("\n").at(-1) ?? "";
        const used = Number(line.split(/\s+/)[4]?.replace("%", ""));
        if (!Number.isFinite(used)) {
            return { ok: true, detail: `无法解析 df 输出，跳过（${line}）` };
        }
        return used > DISK_MAX
            ? { ok: false, detail: `磁盘占用 ${used}% > ${DISK_MAX}%`, value: used }
            : { ok: true, detail: `磁盘占用 ${used}%` };
    } catch (error) {
        return { ok: true, detail: `磁盘检查跳过：${error?.message ?? error}` };
    }
}

/** 资源：容器健康状态（compose 里 app / postgres 都带 healthcheck 或 restart 策略） */
async function probeContainers() {
    try {
        const { stdout } = await run(
            "docker",
            ["compose", "-f", `${APP_DIR}/docker-compose.yml`, "ps", "--format", "json"],
            { maxBuffer: 1024 * 1024 },
        );
        const lines = stdout.trim().split("\n").filter(Boolean);
        if (lines.length === 0) {
            return { ok: false, detail: "没有任何运行中的容器" };
        }
        const unhealthy = [];
        for (const line of lines) {
            const service = JSON.parse(line);
            const state = String(service.State ?? "");
            const health = String(service.Health ?? "");
            if (state !== "running" || (health && health !== "healthy")) {
                unhealthy.push(`${service.Service}=${state}${health ? `/${health}` : ""}`);
            }
        }
        return unhealthy.length > 0
            ? { ok: false, detail: `容器异常：${unhealthy.join(", ")}` }
            : { ok: true, detail: `${lines.length} 个容器均正常` };
    } catch (error) {
        return { ok: true, detail: `容器检查跳过：${error?.message ?? error}` };
    }
}

/* ------------------------------------------------------------------ *
 * 告警出口（只发开发者）
 * ------------------------------------------------------------------ */

async function deliver({ severity, title, detail, recovered }) {
    const text = `[${severity}] Tablely ${recovered ? "已恢复" : "告警"}：${title}\n${detail}\n主机：${APP_DIR}`;
    const webhook = process.env.ALERT_WEBHOOK_URL;
    if (!webhook) {
        console.log(`${text}\n（未配置 ALERT_WEBHOOK_URL，仅打印）`);
        return;
    }
    // 按 URL 自动选入站格式：飞书群自定义机器人要求 `msg_type` 包裹，
    // 直接 POST `{"text":...}` 会被它拒（HTTP 200 但 body 里 `code != 0`）。
    const isFeishu = /open\.feishu\.cn|open\.larksuite\.com/.test(webhook);
    const payload = isFeishu
        ? { msg_type: "text", content: { text } }
        : { text, severity, title, detail, recovered };
    try {
        const response = await fetch(webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            console.log(`发送失败 HTTP ${response.status}：${title}`);
            return;
        }
        // ⚠️ 飞书成功与失败都可能返 HTTP 200，**必须读 body 的 `code`** 才算真发出
        if (isFeishu) {
            const result = await response.json().catch(() => null);
            if (!result || result.code !== 0) {
                console.error(`飞书拒收：${JSON.stringify(result)}（${title}）`);
                return;
            }
        }
        console.log(`已发送：${title}`);
    } catch (error) {
        console.error(`告警发送失败：${error?.message ?? error}`);
    }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
    const state = await loadState();
    state.sent ??= {};
    state.active ??= {};

    const health = await probeHealth();
    // 连续失败计数跨次运行累计（探针每 5 分钟一次，故两次失败 ≈ 10 分钟内确认）
    state.healthFails = health.ok ? 0 : (state.healthFails ?? 0) + 1;

    const results = [
        {
            key: "health",
            title: "可用性：/healthz",
            ok: health.ok,
            // 单次失败只是 P2 抖动，连续失败才升级为 P1
            severity: state.healthFails >= HEALTH_FAILS_FOR_P1 ? "P1" : "P2",
            detail: `${health.detail}（连续失败 ${state.healthFails} 次）`,
        },
        {
            key: "disk",
            title: "资源：磁盘水位",
            ...(await probeDisk()),
            severity: "P1",
        },
        {
            key: "containers",
            title: "资源：容器健康",
            ...(await probeContainers()),
            severity: "P1",
        },
    ];

    const now = Date.now();

    for (const result of results) {
        if (!result.ok) {
            const last = state.sent[result.key];
            // 升级（P2 → P1）必须立即补发，不能被降噪窗口吞掉，否则「连续 2 次失败 → P1」形同虚设
            const escalated = rankOf(result.severity) > rankOf(last?.severity);
            if (!escalated && now - (last?.at ?? 0) < QUIET_MS) {
                console.log(
                    `静默中（同类告警 ${QUIET_MS / 60000} 分钟内只发一次）：${result.title}`,
                );
            } else {
                await deliver({
                    severity: result.severity,
                    title: result.title,
                    detail: result.detail,
                    recovered: false,
                });
                state.sent[result.key] = { at: now, severity: result.severity };
            }
            state.active[result.key] = true;
            continue;
        }

        // 恢复正常时补一条「已恢复」（不计入降噪窗口，避免故障时长被静默掩盖）
        if (state.active[result.key]) {
            await deliver({
                severity: "P2",
                title: result.title,
                detail: result.detail,
                recovered: true,
            });
            delete state.active[result.key];
            delete state.sent[result.key];
        } else {
            console.log(`正常：${result.title}（${result.detail}）`);
        }
    }

    await saveState(state);
}

main().catch((error) => {
    console.error(`探针执行失败：${error?.stack ?? error}`);
    process.exitCode = 1;
});
