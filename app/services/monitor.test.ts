import { afterEach, describe, expect, it, vi } from "vitest";
import {
    APP_VERSION,
    checkDiscountIntegrity,
    DEFAULT_ALERT_POLICY,
    FailureCounter,
    logStructured,
    runDailyDiscountIntegrityCheck,
    shouldAlert,
    type DiscountIntegrityInput,
    type DiscountIntegrityDeps,
} from "./monitor.server";

/* ------------------------------------------------------------------ *
 * ① 结构化日志
 * ------------------------------------------------------------------ */

describe("logStructured（§21.5 结构化 JSON 日志）", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("输出单行 JSON，含 ts / level / event / version", () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => { });
        const line = logStructured("info", "webhooks.received", { topic: "SHOP_REDACT" });

        expect(line).not.toContain("\n");
        const parsed = JSON.parse(line);
        expect(parsed.level).toBe("info");
        expect(parsed.event).toBe("webhooks.received");
        expect(parsed.version).toBe(APP_VERSION);
        expect(typeof parsed.ts).toBe("string");
        expect(parsed.topic).toBe("SHOP_REDACT");
        expect(spy).toHaveBeenCalledWith(line);
    });

    it("error 走 stderr、warn 走 warn（分级可见）", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });

        logStructured("error", "healthz.db_unreachable");
        logStructured("warn", "appproxy.signature_invalid");

        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).not.toHaveBeenCalled();
    });

    it("敏感键被脱敏：token / secret / HMAC / email / payload（含嵌套）", () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        const line = logStructured("info", "test.redaction", {
            accessToken: "shpat_should_not_leak",
            apiSecret: "shpss_should_not_leak",
            hmacHeader: "abc123",
            customerEmail: "buyer@example.com",
            payload: { email: "buyer@example.com", id: 123 },
            nested: { authorization: "Bearer xyz", topic: "ORDERS_CREATE" },
            safeField: "visible",
        });

        expect(line).not.toContain("shpat_should_not_leak");
        expect(line).not.toContain("shpss_should_not_leak");
        expect(line).not.toContain("abc123");
        expect(line).not.toContain("buyer@example.com");
        expect(line).not.toContain("Bearer xyz");

        const parsed = JSON.parse(line);
        expect(parsed.accessToken).toBe("[redacted]");
        expect(parsed.payload).toBe("[redacted]");
        expect(parsed.nested.authorization).toBe("[redacted]");
        expect(parsed.nested.topic).toBe("ORDERS_CREATE");
        expect(parsed.safeField).toBe("visible");
    });
});

/* ------------------------------------------------------------------ *
 * ② 关键路径失败计数
 * ------------------------------------------------------------------ */

describe("FailureCounter / shouldAlert（§21.5 错误层）", () => {
    it("只统计被记录的路径，未记录的路径不出现在快照里", () => {
        const counter = new FailureCounter();
        counter.record("api.addtocart", true);
        counter.record("api.addtocart", false);

        const snapshot = counter.snapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0]).toMatchObject({
            path: "api.addtocart",
            total: 2,
            failures: 1,
            failureRate: 0.5,
        });
    });

    it("样本数为 0 时失败率为 0（不产生 NaN）", () => {
        expect(new FailureCounter().snapshot()).toEqual([]);
        expect(shouldAlert({ path: "x", total: 0, failures: 0, failureRate: 0 })).toBe(false);
    });

    it("阈值边界：恰好等于阈值不告警，超过才告警（§21.5 加购 5xx > 5%）", () => {
        const policy = { minSamples: 20, threshold: 0.05 };
        expect(
            shouldAlert({ path: "p", total: 20, failures: 1, failureRate: 0.05 }, policy),
        ).toBe(false);
        expect(
            shouldAlert({ path: "p", total: 20, failures: 2, failureRate: 0.1 }, policy),
        ).toBe(true);
    });

    it("样本不足时不告警（避免启动期误报）", () => {
        const snapshot = { path: "p", total: 3, failures: 3, failureRate: 1 };
        expect(shouldAlert(snapshot, DEFAULT_ALERT_POLICY)).toBe(false);
    });
});

/* ------------------------------------------------------------------ *
 * ③ 折扣完整性巡检
 * ------------------------------------------------------------------ */

const LIVE_ACTIVE = [
    { id: "gid://tier", status: "ACTIVE" },
    { id: "gid://whole", status: "ACTIVE" },
    { id: "gid://mix", status: "ACTIVE" },
];

function proInput(overrides: Partial<DiscountIntegrityInput> = {}): DiscountIntegrityInput {
    return {
        shop: "a.myshopify.com",
        plan: "pro",
        state: {
            tierDiscountId: "gid://tier",
            wholeDiscountId: "gid://whole",
            mixMatchDiscountId: "gid://mix",
            active: true,
        },
        liveDiscounts: LIVE_ACTIVE,
        ...overrides,
    };
}

describe("checkDiscountIntegrity（§21.5 业务完整性层 / §2.2.2）", () => {
    it("Pro 店三个折扣齐全且 ACTIVE → 无问题", () => {
        expect(checkDiscountIntegrity(proInput())).toEqual([]);
    });

    it("Pro 店折扣数量不足 3 条 → P1", () => {
        const issues = checkDiscountIntegrity(
            proInput({
                state: {
                    tierDiscountId: "gid://tier",
                    wholeDiscountId: "gid://whole",
                    mixMatchDiscountId: null,
                    active: true,
                },
            }),
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: "discount_missing", severity: "P1" });
    });

    it("折扣被商家删除 → P1（改价类应用的致命故障）", () => {
        const issues = checkDiscountIntegrity(
            proInput({ liveDiscounts: LIVE_ACTIVE.slice(0, 2) }),
        );
        expect(issues.map((issue) => issue.code)).toContain("discount_deleted");
        expect(issues.every((issue) => issue.severity === "P1")).toBe(true);
    });

    it("折扣存在但状态非 ACTIVE → P1", () => {
        const issues = checkDiscountIntegrity(
            proInput({
                liveDiscounts: [
                    { id: "gid://tier", status: "EXPIRED" },
                    { id: "gid://whole", status: "ACTIVE" },
                    { id: "gid://mix", status: "ACTIVE" },
                ],
            }),
        );
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: "discount_not_active", severity: "P1" });
    });

    it("Pro 店记录为 inactive → P1", () => {
        const issues = checkDiscountIntegrity(
            proInput({
                state: {
                    tierDiscountId: "gid://tier",
                    wholeDiscountId: "gid://whole",
                    mixMatchDiscountId: "gid://mix",
                    active: false,
                },
            }),
        );
        expect(issues.map((issue) => issue.code)).toContain("discount_inactive");
    });

    it("非 Pro 店：折扣为 inactive 属正常，仍 active 才是问题（P2）", () => {
        const base = {
            shop: "a.myshopify.com",
            plan: "free",
            liveDiscounts: LIVE_ACTIVE,
        };
        expect(
            checkDiscountIntegrity({
                ...base,
                state: {
                    tierDiscountId: "gid://tier",
                    wholeDiscountId: "gid://whole",
                    mixMatchDiscountId: "gid://mix",
                    active: false,
                },
            }),
        ).toEqual([]);

        const issues = checkDiscountIntegrity({
            ...base,
            state: {
                tierDiscountId: "gid://tier",
                wholeDiscountId: "gid://whole",
                mixMatchDiscountId: "gid://mix",
                active: true,
            },
        });
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: "discount_active_on_free", severity: "P2" });
    });

    it("Pro 店尚无折扣状态记录 → P2（不误报 P1）", () => {
        const issues = checkDiscountIntegrity(proInput({ state: null }));
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: "discount_state_missing", severity: "P2" });
    });

    it("Free 店尚无折扣状态记录 → 无问题（从未 Pro 的店按设计不创建折扣）", () => {
        expect(
            checkDiscountIntegrity({
                shop: "a.myshopify.com",
                plan: "free",
                state: null,
                liveDiscounts: [],
            }),
        ).toEqual([]);
    });
});

describe("runDailyDiscountIntegrityCheck（巡检骨架）", () => {
    it("逐店汇总问题，并对 P1 落 error 级日志", async () => {
        const logSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        const deps: DiscountIntegrityDeps = {
            listShops: async () => [
                { shop: "ok.myshopify.com", plan: "pro" },
                { shop: "broken.myshopify.com", plan: "pro" },
            ],
            loadDiscountState: async () => ({
                tierDiscountId: "gid://tier",
                wholeDiscountId: "gid://whole",
                mixMatchDiscountId: "gid://mix",
                active: true,
            }),
            listLiveDiscounts: async (shop) =>
                shop === "broken.myshopify.com" ? [] : LIVE_ACTIVE,
        };

        const issues = await runDailyDiscountIntegrityCheck(deps);

        expect(issues).toHaveLength(3); // 坏店：3 个折扣全部 deleted
        expect(issues.every((issue) => issue.shop === "broken.myshopify.com")).toBe(true);
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
            event: "integrity.discount_check",
            shops: 2,
            p1: 3,
        });

        vi.restoreAllMocks();
    });

    it("全部正常时落 info 级日志且无问题", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const deps: DiscountIntegrityDeps = {
            listShops: async () => [{ shop: "ok.myshopify.com", plan: "pro" }],
            loadDiscountState: async () => ({
                tierDiscountId: "gid://tier",
                wholeDiscountId: "gid://whole",
                mixMatchDiscountId: "gid://mix",
                active: true,
            }),
            listLiveDiscounts: async () => LIVE_ACTIVE,
        };

        const issues = await runDailyDiscountIntegrityCheck(deps);

        expect(issues).toEqual([]);
        expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({ p1: 0 });
        vi.restoreAllMocks();
    });
});