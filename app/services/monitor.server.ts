/**
 * Y7 运行监控（§21.5）
 *
 * 「容器健康检查 + 结构化日志 + 一个免费外部探针」三件套中的后两件：
 *   ① 结构化 JSON 日志（stdout）—— 供日志采集按 event 统计
 *   ② 关键路径失败计数 —— oauth / appproxy.* / api.addtocart / webhooks.*
 *   ③ 折扣完整性巡检 —— 每店 automatic discount 必须仍为 3 条且状态符合套餐
 *      （改价类应用的致命故障，§2.2.2 / §十三 Y7）
 *
 * 纪律（与 §8.2 D 一致）：
 *   - **不打印 PII / token / HMAC / SHOPIFY_API_SECRET** —— 敏感键一律脱敏；
 *   - 日志有 rotation 上限（部署层，§21.5），本模块只保证单行 JSON、不含换行；
 *   - 告警**只发给开发者自己**，绝不发给商家（与 Y4 一致）；
 *   - 不引入付费 APM / 分布式追踪。
 */

/* ------------------------------------------------------------------ *
 * ① 版本号（`/healthz` 返回，零信息泄露：只暴露版本字符串）
 * ------------------------------------------------------------------ */

/** 生产镜像在构建时注入；本地 / 未注入时为 `0.0.0-dev` */
export const APP_VERSION = process.env.APP_VERSION ?? "0.0.0-dev";

/* ------------------------------------------------------------------ *
 * ② 结构化日志（stdout）
 * ------------------------------------------------------------------ */

export type LogLevel = "info" | "warn" | "error";

/** 命中即脱敏的键名（大小写不敏感，子串匹配） */
const REDACT_KEY_PATTERN =
    /(pass|secret|token|hmac|signature|authorization|cookie|email|phone|address|payload)/i;
const REDACTED = "[redacted]";
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 50;

/**
 * 递归脱敏：只保留结构，敏感键的值替换为 `[redacted]`。
 * 深度与数组长度都有上限，避免异常对象把日志撑爆（§21.5 磁盘纪律）。
 */
function sanitize(value: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH) return "[truncated]";
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED : sanitize(item, depth + 1);
    }
    return out;
}

/**
 * 输出一行结构化 JSON 日志并返回该行（返回值为便于单测断言）。
 *
 * 约定：`event` 用点分命名空间（如 `webhooks.received` / `healthz.db_unreachable`），
 * 便于按前缀统计；`fields` 里的敏感键会被自动脱敏。
 */
export function logStructured(
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
): string {
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        version: APP_VERSION,
        ...(sanitize(fields) as Record<string, unknown>),
    });

    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    return line;
}

/* ------------------------------------------------------------------ *
 * ③ 关键路径失败计数（§21.5 错误层）
 * ------------------------------------------------------------------ */

/** 被监控的关键路径（§21.5：oauth、appproxy.*、api.addtocart、webhooks.*） */
export const MONITORED_PATHS = [
    "oauth",
    "appproxy.apply",
    "appproxy.quick-order",
    "appproxy.history",
    "appproxy.quote",
    "api.addtocart",
    "webhooks",
] as const;

export type MonitoredPath = (typeof MONITORED_PATHS)[number];

export interface PathFailureSnapshot {
    path: string;
    total: number;
    failures: number;
    /** 失败率，0–1；无样本时为 0 */
    failureRate: number;
}

/** 进程内累计计数（跨重启清零——只做分钟级的「异常升高」判定，不做长期报表） */
export class FailureCounter {
    private readonly counts = new Map<string, { total: number; failures: number }>();

    record(path: string, ok: boolean): void {
        const current = this.counts.get(path) ?? { total: 0, failures: 0 };
        current.total += 1;
        if (!ok) current.failures += 1;
        this.counts.set(path, current);
    }

    snapshot(): PathFailureSnapshot[] {
        return [...this.counts.entries()].map(([path, { total, failures }]) => ({
            path,
            total,
            failures,
            failureRate: total === 0 ? 0 : failures / total,
        }));
    }

    reset(): void {
        this.counts.clear();
    }
}

export interface AlertPolicy {
    /** 样本数下限：样本太少时的高失败率不算异常（避免启动期误报） */
    minSamples: number;
    /** 失败率阈值，超过才告警 */
    threshold: number;
}

/** §21.5：加购上报 5xx 比例 > 5% → P1 */
export const DEFAULT_ALERT_POLICY: AlertPolicy = { minSamples: 20, threshold: 0.05 };

/** 判断某路径是否达到告警条件（纯函数，便于单测） */
export function shouldAlert(
    snapshot: PathFailureSnapshot,
    policy: AlertPolicy = DEFAULT_ALERT_POLICY,
): boolean {
    return snapshot.total >= policy.minSamples && snapshot.failureRate > policy.threshold;
}

/* ------------------------------------------------------------------ *
 * ④ 折扣完整性巡检（§21.5 业务完整性层 / §2.2.2）
 * ------------------------------------------------------------------ */

export type Severity = "P1" | "P2";

export interface IntegrityIssue {
    shop: string;
    /** 机器可读的问题码，用于日志 / 去重 */
    code: string;
    severity: Severity;
    detail: string;
}

export interface DiscountRef {
    id: string;
    /** Shopify 返回的折扣状态，如 ACTIVE / EXPIRED / SCHEDULED */
    status: string;
}

export interface DiscountStateSnapshot {
    tierDiscountId: string | null;
    wholeDiscountId: string | null;
    mixMatchDiscountId: string | null;
    active: boolean;
}

export interface DiscountIntegrityInput {
    shop: string;
    /** free | pro（PlanState.plan） */
    plan: string;
    /** 应用记录的折扣状态；未创建 / 从未同步时为 null */
    state: DiscountStateSnapshot | null;
    /** 该店当前实际存在的 automatic discount */
    liveDiscounts: DiscountRef[];
}

/** 每店应有 3 个 automatic discount：阶梯价 / 批发价 / 混单（§2.2.2） */
export const EXPECTED_DISCOUNT_COUNT = 3;

const DISCOUNT_SLOTS = [
    { key: "tierDiscountId", label: "阶梯价" },
    { key: "wholeDiscountId", label: "批发价" },
    { key: "mixMatchDiscountId", label: "混单" },
] as const;

/**
 * 纯函数：按 §21.5 判定「折扣是否还在且状态符合套餐」。
 * 只读输入、不做 IO，M12/M15 负责注入真实的 Admin API 数据。
 */
export function checkDiscountIntegrity(input: DiscountIntegrityInput): IntegrityIssue[] {
    const { shop, plan, state, liveDiscounts } = input;
    const issues: IntegrityIssue[] = [];

    if (!state) {
        issues.push({
            shop,
            code: "discount_state_missing",
            severity: "P2",
            detail: "尚无折扣状态记录（未创建或从未同步）",
        });
        return issues;
    }

    const ids: Array<{ label: string; id: string }> = [];
    for (const slot of DISCOUNT_SLOTS) {
        const id = state[slot.key];
        if (id) ids.push({ label: slot.label, id });
    }
    const liveById = new Map(liveDiscounts.map((discount) => [discount.id, discount]));

    if (plan === "pro") {
        if (ids.length !== EXPECTED_DISCOUNT_COUNT) {
            issues.push({
                shop,
                code: "discount_missing",
                severity: "P1",
                detail: `Pro 店应有 ${EXPECTED_DISCOUNT_COUNT} 个折扣，记录中只有 ${ids.length} 个`,
            });
        }
        if (!state.active) {
            issues.push({
                shop,
                code: "discount_inactive",
                severity: "P1",
                detail: "Pro 店折扣状态为 inactive（店面改价会失效）",
            });
        }
        for (const slot of ids) {
            const live = liveById.get(slot.id);
            if (!live) {
                issues.push({
                    shop,
                    code: "discount_deleted",
                    severity: "P1",
                    detail: `${slot.label}折扣 ${slot.id} 在店铺中已不存在`,
                });
            } else if (live.status !== "ACTIVE") {
                issues.push({
                    shop,
                    code: "discount_not_active",
                    severity: "P1",
                    detail: `${slot.label}折扣 ${slot.id} 状态为 ${live.status}`,
                });
            }
        }
    } else if (state.active) {
        // 非 Pro（含降级）必须为 inactive：仅停用不删除（§2.2.2）
        issues.push({
            shop,
            code: "discount_active_on_free",
            severity: "P2",
            detail: "非 Pro 店折扣仍为 active（降级未生效）",
        });
    }

    return issues;
}

/** 巡检所需的数据来源；M12/M15 接真实实现（Admin API + DB），M2 只定契约 */
export interface DiscountIntegrityDeps {
    listShops(): Promise<Array<{ shop: string; plan: string }>>;
    loadDiscountState(shop: string): Promise<DiscountStateSnapshot | null>;
    listLiveDiscounts(shop: string): Promise<DiscountRef[]>;
}

/**
 * 每日巡检骨架（§21.5 业务完整性层）：遍历店铺 → 比对记录与实际 →
 * 汇总 P1 并落一行结构化日志。返回问题列表，由上层决定是否推送告警。
 */
export async function runDailyDiscountIntegrityCheck(
    deps: DiscountIntegrityDeps,
): Promise<IntegrityIssue[]> {
    const shops = await deps.listShops();
    const issues: IntegrityIssue[] = [];

    for (const { shop, plan } of shops) {
        const state = await deps.loadDiscountState(shop);
        const liveDiscounts = state ? await deps.listLiveDiscounts(shop) : [];
        issues.push(...checkDiscountIntegrity({ shop, plan, state, liveDiscounts }));
    }

    const p1 = issues.filter((issue) => issue.severity === "P1").length;
    logStructured(p1 > 0 ? "error" : "info", "integrity.discount_check", {
        shops: shops.length,
        issues: issues.length,
        p1,
    });

    return issues;
}