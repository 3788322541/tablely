/**
 * 指标纯函数（M15 / §22）
 *
 * §22 的口径要求「不新增表、不建后台指标页，出数靠一段只读脚本」，
 * 所以本文件只做**纯计算**：输入是已从 DB 取出的行，输出是数字，
 * 不 import Prisma、不碰网络 —— 这样口径可被单测逐条钉住（`metrics.test.ts`）。
 * 取数与格式化在 `scripts/metrics.ts`（只读 SQL → Markdown / CSV）。
 *
 * ⚠️ 已如实记录的局限：
 *   ① 分周口径按 **UTC**（本项目的 `ShopSettings` 未存店铺时区；§2.6 提到按店铺时区，
 *      但单容器 + 单库无法在 SQL 侧换算，故按 UTC 周一切分，误差 ≤ 1 天）；
 *   ② **降级后 30 天恢复率**需要 Billing 事件历史，DB 只有快照 → 这里只给「当前处于降级的
 *      店铺数」与「看过降级说明卡后又回到 Pro 的店铺数」两个代理值，精确值以 Partner Dashboard 为准。
 */

/* ------------------------------------------------------------------ *
 * 输入行（只读投影，字段口径对应 prisma/schema.prisma）
 * ------------------------------------------------------------------ */

export interface ShopActivationRow {
    shop: string;
    /** 即 installedAt（§22.3 激活漏斗第 0 步） */
    createdAt: Date;
    blockAddedAt: Date | null;
    firstProductAt: Date | null;
    firstAddToCart: Date | null;
}

export interface AddToCartRow {
    shop: string;
    rows: number;
    quantity: number;
    createdAt: Date;
}

export interface PlanRow {
    shop: string;
    /** free | pro */
    plan: string;
    trialEndsAt: Date | null;
    everPro: boolean;
    winbackSeenAt: Date | null;
}

export interface ApplicationRow {
    shop: string;
    /** pending | approved | rejected */
    status: string;
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** 中位数（偶数个取中间两者均值）；空数组返回 null，避免把「无数据」当 0 */
export function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 百分比（保留 1 位小数）；分母为 0 时返回 null 而不是 0 */
export function percent(part: number, total: number): number | null {
    if (total <= 0) return null;
    return Math.round((part / total) * 1000) / 10;
}

/** 保留 1 位小数 */
export function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

/** UTC 口径的 ISO 周起始（周一 00:00） */
export function startOfIsoWeek(date: Date): Date {
    const day = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day;
}

export function toIsoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * 激活漏斗（§22.1 激活层）
 * ------------------------------------------------------------------ */

export interface ActivationFunnel {
    installed: number;
    blockAdded: number;
    firstProduct: number;
    firstAddToCart: number;
    blockAddedRate: number | null;
    firstProductRate: number | null;
    firstAddToCartRate: number | null;
    /** 安装 → 首次加购成功的中位小时数（§22.1 ≤ 24h） */
    medianHoursToFirstAddToCart: number | null;
}

export function activationFunnel(shops: ShopActivationRow[]): ActivationFunnel {
    const installed = shops.length;
    const blockAdded = shops.filter((shop) => shop.blockAddedAt).length;
    const firstProduct = shops.filter((shop) => shop.firstProductAt).length;
    const activated = shops.filter((shop) => shop.firstAddToCart);
    const hours = activated.map(
        (shop) => (shop.firstAddToCart as Date).getTime() - shop.createdAt.getTime(),
    );
    const medianMs = median(hours);

    return {
        installed,
        blockAdded,
        firstProduct,
        firstAddToCart: activated.length,
        blockAddedRate: percent(blockAdded, installed),
        firstProductRate: percent(firstProduct, installed),
        firstAddToCartRate: percent(activated.length, installed),
        medianHoursToFirstAddToCart:
            medianMs === null ? null : round1(medianMs / (60 * 60 * 1000)),
    };
}

/* ------------------------------------------------------------------ *
 * 使用层（§22.1 使用层 / 北极星）
 * ------------------------------------------------------------------ */

export interface WeeklyActiveShops {
    /** 该周起始（周一，YYYY-MM-DD） */
    weekStart: string;
    activeShops: number;
}

/**
 * 周活跃店铺（WAS）：一周内 ≥1 次加购提交的店铺数，按 ISO 周分桶、最近 N 周。
 * 返回按时间升序（最后一项是本周），便于脚本直接画趋势。
 */
export function weeklyActiveShops(
    events: AddToCartRow[],
    options: { weeks: number; now?: Date },
): WeeklyActiveShops[] {
    const now = options.now ?? new Date();
    const currentWeek = startOfIsoWeek(now);
    const buckets = new Map<number, Set<string>>();

    for (let index = 0; index < options.weeks; index += 1) {
        const start = currentWeek.getTime() - index * MS_PER_WEEK;
        buckets.set(start, new Set<string>());
    }

    for (const event of events) {
        const start = startOfIsoWeek(event.createdAt).getTime();
        buckets.get(start)?.add(event.shop);
    }

    return [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([start, shops]) => ({
            weekStart: toIsoDate(new Date(start)),
            activeShops: shops.size,
        }));
}

/**
 * 每店每周加购提交数（中位）。
 *
 * 口径（§22.1）：**剔除单次试玩店铺** —— 窗口内总提交数 < 2 的店铺不计入；
 * 每店取其「有提交的周」的平均提交数，再对全体取中位。
 */
export function medianWeeklySubmissionsPerShop(
    events: AddToCartRow[],
    options: { weeks: number; now?: Date },
): number | null {
    const now = options.now ?? new Date();
    const earliest = startOfIsoWeek(now).getTime() - (options.weeks - 1) * MS_PER_WEEK;
    const perShop = new Map<string, Map<number, number>>();

    for (const event of events) {
        if (event.createdAt.getTime() < earliest) continue;
        const week = startOfIsoWeek(event.createdAt).getTime();
        const weeks = perShop.get(event.shop) ?? new Map<number, number>();
        weeks.set(week, (weeks.get(week) ?? 0) + 1);
        perShop.set(event.shop, weeks);
    }

    const averages: number[] = [];
    for (const weeks of perShop.values()) {
        const total = [...weeks.values()].reduce((sum, count) => sum + count, 0);
        if (total < 2) continue; // 剔除单次试玩店铺
        averages.push(total / weeks.size);
    }
    const value = median(averages);
    return value === null ? null : round1(value);
}

/** 平均每单行数（§22.1 ≥ 3 行；每条事件即一次提交） */
export function averageRowsPerSubmission(events: AddToCartRow[]): number | null {
    const value = mean(events.map((event) => event.rows));
    return value === null ? null : round1(value);
}

/** 平均每单件数（观察值，不计入 §22.1 目标） */
export function averageQuantityPerSubmission(
    events: AddToCartRow[],
): number | null {
    const value = mean(events.map((event) => event.quantity));
    return value === null ? null : round1(value);
}

/* ------------------------------------------------------------------ *
 * 留存（§22.1 留存层）
 * ------------------------------------------------------------------ */

export interface RetentionResult {
    /** 已满观察期、可计入的安装店铺数 */
    cohort: number;
    /** 在「安装后第 N 天所在那周」仍有加购提交的店铺数 */
    retained: number;
    rate: number | null;
}

/**
 * N 天留存：只统计安装已满 N 天的店铺，看它们在「安装 + N 天」当周（ISO 周）内
 * 是否仍有 ≥1 次加购提交。未满观察期的店铺不进入分母（避免早期虚高）。
 */
export function retentionAtDays(
    shops: ShopActivationRow[],
    events: AddToCartRow[],
    options: { days: number; now?: Date },
): RetentionResult {
    const now = options.now ?? new Date();
    const cutoff = now.getTime() - options.days * MS_PER_DAY;
    const cohort = shops.filter((shop) => shop.createdAt.getTime() <= cutoff);

    const activatedShops = new Set<string>();
    for (const shop of cohort) {
        const targetWeek = startOfIsoWeek(
            new Date(shop.createdAt.getTime() + options.days * MS_PER_DAY),
        ).getTime();
        const hit = events.some(
            (event) =>
                event.shop === shop.shop &&
                startOfIsoWeek(event.createdAt).getTime() === targetWeek,
        );
        if (hit) activatedShops.add(shop.shop);
    }

    return {
        cohort: cohort.length,
        retained: activatedShops.size,
        rate: percent(activatedShops.size, cohort.length),
    };
}

/* ------------------------------------------------------------------ *
 * 变现（§22.1 变现层）与反指标（§22.2）
 * ------------------------------------------------------------------ */

export interface MonetizationSnapshot {
    /** 进入过试用 / 曾为 Pro 的店铺数（分母） */
    trialStarted: number;
    /** 当前 ACTIVE（plan = pro）的店铺数 */
    activePro: number;
    trialToPaidRate: number | null;
    /** 当前处于降级（曾为 Pro 但现在 free）的店铺数 —— 反指标① */
    downgradedNow: number;
    /** 看过降级说明卡、当前又回到 Pro 的店铺数（win-back 代理值） */
    winbackReturned: number;
}

export function monetizationSnapshot(
    plans: PlanRow[],
): MonetizationSnapshot {
    const trialStarted = plans.filter(
        (plan) => plan.everPro || plan.trialEndsAt !== null,
    );
    const activePro = plans.filter((plan) => plan.plan === "pro");
    const downgradedNow = plans.filter(
        (plan) => plan.everPro && plan.plan !== "pro",
    );
    const winbackReturned = plans.filter(
        (plan) =>
            plan.everPro && plan.plan === "pro" && plan.winbackSeenAt !== null,
    );

    return {
        trialStarted: trialStarted.length,
        activePro: activePro.length,
        trialToPaidRate: percent(activePro.length, trialStarted.length),
        downgradedNow: downgradedNow.length,
        winbackReturned: winbackReturned.length,
    };
}

/**
 * App Block 已添加但未产生过加购的店铺数 —— 反指标④
 * （说明引导或主题兼容有问题，是「激活漏斗卡在哪一步」的直接线索）
 */
export function blockAddedWithoutAddToCart(shops: ShopActivationRow[]): number {
    return shops.filter((shop) => shop.blockAddedAt && !shop.firstAddToCart).length;
}

/* ------------------------------------------------------------------ *
 * 申请表单运营效果（§22.3 —— 沿用既有数据、不新增表）
 * ------------------------------------------------------------------ */

export interface ApplicationStats {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    approvalRate: number | null;
}

export function applicationStats(rows: ApplicationRow[]): ApplicationStats {
    const approved = rows.filter((row) => row.status === "approved").length;
    const rejected = rows.filter((row) => row.status === "rejected").length;
    return {
        total: rows.length,
        pending: rows.filter((row) => row.status === "pending").length,
        approved,
        rejected,
        // 分母用已裁决数（pending 尚未决定，纳入会低估通过率）
        approvalRate: percent(approved, approved + rejected),
    };
}
