import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { auditDiscounts } from "../services/discounts.server";
import { logStructured, type IntegrityIssue } from "../services/monitor.server";
import { formatIntegrityReport, notifyDeveloper } from "../services/notify.server";
import { constantTimeEqual } from "../services/security.server";
import { resolvePlan } from "../services/tables.server";

/**
 * 折扣完整性每日巡检 /api/internal/discount-integrity（§21.5 业务完整性层）
 *
 * 为什么需要这个端点：`runDailyDiscountIntegrityCheck` / `auditDiscounts` 只是**纯逻辑**，
 * 真正巡检需要「Admin 上下文 + DB + 逐店列举」——这三样只有在应用进程里才拿得到，
 * 宿主机 cron 脚本（`scripts/alert.mjs`）拿不到。因此照 Attributly 的
 * `api/internal/cleanup` 模式，在应用里开一个**内网触发端点**，由宿主机 cron 拉起。
 *
 * 鉴权：`X-Cron-Secret` 必须等于 `CRON_SECRET`（常量时间比较，§8.2 C）。
 * ⚠️ 与 §21.5「巡检路由免鉴权」的差异是**刻意的**：本端点会遍历**所有店铺**并调用
 * Admin API，免鉴权等于把「跨店巡检 + API 配额」暴露给任何人。§21.5 那条约束针对的是
 * 外部探针打的无副作用存活检查（`/healthz`），本端点属于**内部定时任务**，必须鉴权。
 *
 * 无副作用纪律：只读（`auditDiscounts` 内部只有查询），不写任何业务表。
 * 唯一例外是 `unauthenticated.admin()` 在离线 token 过期时会刷新会话 —— 这是
 * Shopify 库的必要行为，不属业务数据写入，也不影响「只读巡检」的语义。
 */

function authorized(request: Request): boolean {
    const expected = process.env.CRON_SECRET;
    if (!expected) return false;
    const provided = request.headers.get("x-cron-secret");
    if (!provided) return false;
    return constantTimeEqual(provided, expected);
}

async function handle(request: Request) {
    if (!authorized(request)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // 只巡检「已安装且仍有离线会话」的店铺：卸载会连同 Session 一起清掉
    // （见 uninstall.server.ts），所以卸载店不会进来，也就不存在「查不到 token」的空转。
    const sessions = await prisma.session.findMany({
        where: { isOnline: false },
        select: { shop: true },
        distinct: ["shop"],
    });

    const issues: IntegrityIssue[] = [];
    const failedShops: string[] = [];

    for (const { shop } of sessions) {
        try {
            const plan = await resolvePlan(shop);
            const { admin } = await unauthenticated.admin(shop);
            issues.push(...(await auditDiscounts({ admin, shop, plan })));
        } catch (error) {
            // 单店失败不中断全局巡检（token 被吊销 / API 抖动都属预期内）
            failedShops.push(shop);
            logStructured("warn", "integrity.discount_shop_failed", {
                shop,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    const p1 = issues.filter((issue) => issue.severity === "P1").length;
    logStructured(p1 > 0 ? "error" : "info", "integrity.discount_check", {
        shops: sessions.length,
        shopsFailed: failedShops.length,
        issues: issues.length,
        p1,
    });

    // 只在**有问题**时发告警：每天最多一条，天然满足 §21.5「30 分钟降噪」；
    // 全绿时保持沉默（避免「每天一条没用的消息」把告警通道变成噪音）。
    let delivered = false;
    if (issues.length > 0) {
        const result = await notifyDeveloper(
            formatIntegrityReport(issues, sessions.length),
        );
        delivered = result.delivered;
    }

    return Response.json(
        {
            ok: true,
            shops: sessions.length,
            shopsFailed: failedShops.length,
            issues: issues.length,
            p1,
            delivered,
            details: issues,
        },
        { headers: { "cache-control": "no-store" } },
    );
}

export const loader = async ({ request }: LoaderFunctionArgs) => handle(request);
export const action = async ({ request }: ActionFunctionArgs) => handle(request);