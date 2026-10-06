/**
 * 店铺时区的日历日工具（M14 / §2.6 / §22.3）
 *
 * 报表的「一天」必须是**店铺时区**的一天（Admin API `shop.ianaTimezone`），
 * 而不是 UTC 的一天：商家在美东看「今日」，区间应覆盖美东 00:00 起。
 * 因此所有日期入参都先转成「店铺时区当天 00:00 对应的 UTC 瞬时」再查库。
 *
 * 纯函数、零依赖（不引 prisma / 不引 Admin API），便于单测 ——
 * 与 Attributly 的 `analytics.server.ts` 同一实现（§十 文件清单）。
 */

/** 非法 / 空时区名一律退回 `UTC`（`Intl` 对坏值会抛 `RangeError`，不允许拖垮统计） */
export function safeTimezone(timezone: string): string {
    const value = (timezone ?? "").trim();
    if (!value) return "UTC";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return value;
    } catch {
        return "UTC";
    }
}

/** 某瞬时在指定时区的墙钟时间与 UTC 的偏移量（毫秒，东区为正） */
function tzOffsetMs(timezone: string, at: Date): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(at);
    const get = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value ?? 0);
    const wallClockAsUtc = Date.UTC(
        get("year"),
        get("month") - 1,
        get("day"),
        get("hour") % 24,
        get("minute"),
        get("second"),
    );
    return wallClockAsUtc - at.getTime();
}

/** 某瞬时属于店铺时区的哪一天（`YYYY-MM-DD`；`en-CA` 的日期格式恰好是 ISO） */
export function dayKeyOf(date: Date, timezone: string): string {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: safeTimezone(timezone),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

/** `YYYY-MM-DD` 加减天数（纯日历运算，与时区无关；`days` 可为负） */
export function addDays(dayKey: string, days: number): string {
    const [year, month, day] = dayKey.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days))
        .toISOString()
        .slice(0, 10);
}

/**
 * 店铺时区里某一天 00:00 对应的 UTC 瞬时（区间下界）。
 *
 * ⚠️ 偏移量按该日 UTC 零点估算，跨夏令时切换的那一天可能有 1 小时误差；
 * 对「今日 / 近 7 天 / 近 30 天」的加购统计足够（§2.6 只要求按店铺日历日对齐）。
 */
export function dayStartInTz(dayKey: string, timezone: string): Date {
    const zone = safeTimezone(timezone);
    const [year, month, day] = dayKey.split("-").map(Number);
    const utcMidnight = new Date(Date.UTC(year, month - 1, day));
    return new Date(utcMidnight.getTime() - tzOffsetMs(zone, utcMidnight));
}
