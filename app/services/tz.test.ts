/**
 * 店铺时区日历日工具单测（M14 / §2.6 / §22.3）
 *
 * 红线：统计的「一天」必须按**店铺时区**（Admin API `ianaTimezone`）对齐，
 * 而不是 UTC 日；非法时区必须退回 `UTC` 且不得抛错（不能拖垮统计）。
 *
 * 纯函数、零依赖，直接在 Node 跑（Node 自带完整 ICU，`Intl` 可用）。
 */
import { describe, expect, it } from "vitest";

import { addDays, dayKeyOf, dayStartInTz, safeTimezone } from "./tz";

describe("safeTimezone", () => {
    it("空串 / 空白 → UTC", () => {
        expect(safeTimezone("")).toBe("UTC");
        expect(safeTimezone("   ")).toBe("UTC");
    });

    it("非法时区名 → UTC（不抛错）", () => {
        expect(safeTimezone("Not/AZone")).toBe("UTC");
        expect(safeTimezone("garbage")).toBe("UTC");
    });

    it("合法时区名原样返回", () => {
        expect(safeTimezone("America/New_York")).toBe("America/New_York");
        expect(safeTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
    });
});

describe("dayKeyOf", () => {
    it("按目标时区判定归属日（美东跨日）", () => {
        // UTC 06-15 00:00 在纽约仍是 06-14 20:00
        expect(dayKeyOf(new Date("2026-06-15T00:00:00Z"), "America/New_York")).toBe(
            "2026-06-14",
        );
        expect(dayKeyOf(new Date("2026-06-15T04:00:00Z"), "America/New_York")).toBe(
            "2026-06-15",
        );
    });

    it("按目标时区判定归属日（上海跨日）", () => {
        expect(dayKeyOf(new Date("2026-06-14T15:59:59Z"), "Asia/Shanghai")).toBe(
            "2026-06-14",
        );
        expect(dayKeyOf(new Date("2026-06-14T16:00:00Z"), "Asia/Shanghai")).toBe(
            "2026-06-15",
        );
    });

    it("非法时区退回 UTC", () => {
        expect(dayKeyOf(new Date("2026-06-15T12:00:00Z"), "Not/AZone")).toBe("2026-06-15");
    });
});

describe("addDays", () => {
    it("跨月 / 跨年", () => {
        expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
        expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
        expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    });

    it("闰年 2 月", () => {
        expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
        expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    });

    it("窗口回溯（今日 - 29 = 近 30 天起点）", () => {
        expect(addDays("2026-10-06", -29)).toBe("2026-09-07");
        expect(addDays("2026-06-15", -6)).toBe("2026-06-09");
    });
});

describe("dayStartInTz", () => {
    it("美东夏令时（EDT，UTC-4）", () => {
        expect(dayStartInTz("2026-06-15", "America/New_York").toISOString()).toBe(
            "2026-06-15T04:00:00.000Z",
        );
    });

    it("美东冬令时（EST，UTC-5）", () => {
        expect(dayStartInTz("2026-01-15", "America/New_York").toISOString()).toBe(
            "2026-01-15T05:00:00.000Z",
        );
    });

    it("上海（UTC+8）", () => {
        expect(dayStartInTz("2026-06-15", "Asia/Shanghai").toISOString()).toBe(
            "2026-06-14T16:00:00.000Z",
        );
    });

    it("UTC", () => {
        expect(dayStartInTz("2026-06-15", "UTC").toISOString()).toBe(
            "2026-06-15T00:00:00.000Z",
        );
    });
});
