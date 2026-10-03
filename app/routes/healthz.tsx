import db from "../db.server";
import { APP_VERSION, logStructured } from "../services/monitor.server";

/**
 * Y7 存活探针（§21.5 可用性层）
 *
 * 免鉴权（外部免费探针每 5 分钟打一次），但**零信息泄露**：
 *   只回 `status` / `version` / `db` 三个字段，**不返回任何配置**；
 *   且**不得触发任何写操作** —— 只做一次 `SELECT 1` 的只读连通性检查。
 *
 * 语义：DB 可达 → 200 `{status:"ok"}`；DB 不可达 → 503 `{status:"degraded"}`，
 * 便于外部探针按 HTTP 状态码直接判定（连续 2 次失败 → P1，§21.5）。
 */
export const loader = async () => {
    let dbOk = false;
    try {
        await db.$queryRaw`SELECT 1`;
        dbOk = true;
    } catch (error) {
        // 只记录错误类型，不打印连接串（可能含口令）
        logStructured("error", "healthz.db_unreachable", {
            reason: error instanceof Error ? error.name : "unknown",
        });
    }

    return Response.json(
        {
            status: dbOk ? "ok" : "degraded",
            version: APP_VERSION,
            db: dbOk,
        },
        {
            status: dbOk ? 200 : 503,
            headers: { "cache-control": "no-store" },
        },
    );
};