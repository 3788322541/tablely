import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    sessions: vi.fn(),
    admin: vi.fn(),
    audit: vi.fn(),
    plan: vi.fn(),
    notify: vi.fn(),
}));

vi.mock("../db.server", () => ({
    default: {
        session: { findMany: (...args: unknown[]) => h.sessions(...args) },
    },
}));

vi.mock("../shopify.server", () => ({
    unauthenticated: { admin: (...args: unknown[]) => h.admin(...args) },
}));

vi.mock("../services/discounts.server", () => ({
    auditDiscounts: (...args: unknown[]) => h.audit(...args),
}));

vi.mock("../services/tables.server", () => ({
    resolvePlan: (...args: unknown[]) => h.plan(...args),
}));

vi.mock("../services/notify.server", () => ({
    notifyDeveloper: (...args: unknown[]) => h.notify(...args),
    formatIntegrityReport: () => "report",
}));

vi.mock("../services/monitor.server", () => ({ logStructured: vi.fn() }));

import { loader } from "../routes/api.internal.discount-integrity";

/**
 * 折扣完整性巡检端点的鉴权与编排契约（§21.5 业务完整性层）。
 *
 * 只测「鉴权闸门 + 逐店编排 + 告警触发」，不连库、不连 Shopify ——
 * 判定逻辑本身已由 monitor.test.ts 的 `checkDiscountIntegrity` 钉死。
 */
const URL_ = "https://tablely.zhenjunit.com/api/internal/discount-integrity";

function call(secret?: string) {
    const request = new Request(URL_, {
        headers: secret ? { "x-cron-secret": secret } : {},
    });
    return loader({ request } as never);
}

const P1_ISSUE = {
    shop: "a.myshopify.com",
    code: "discount_deleted",
    severity: "P1" as const,
    detail: "阶梯价折扣 123 在店铺中已不存在",
};

beforeEach(() => {
    h.sessions.mockReset();
    h.admin.mockReset();
    h.audit.mockReset();
    h.plan.mockReset();
    h.notify.mockReset();
    delete process.env.CRON_SECRET;
});

describe("api/internal/discount-integrity 鉴权", () => {
    it("未配置 CRON_SECRET → 401，且不触碰数据库", async () => {
        const response = await call("whatever");
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
            ok: false,
            error: "unauthorized",
        });
        expect(h.sessions).not.toHaveBeenCalled();
    });

    it("密钥不符 → 401", async () => {
        process.env.CRON_SECRET = "s3cret";
        expect((await call("wrong")).status).toBe(401);
        expect((await call()).status).toBe(401);
        expect(h.sessions).not.toHaveBeenCalled();
    });
});

describe("api/internal/discount-integrity 编排", () => {
    beforeEach(() => {
        process.env.CRON_SECRET = "s3cret";
    });

    it("密钥正确 → 逐店巡检；全绿时保持沉默（不发告警）", async () => {
        h.sessions.mockResolvedValue([{ shop: "a.myshopify.com" }]);
        h.plan.mockResolvedValue("pro");
        h.admin.mockResolvedValue({ admin: {} });
        h.audit.mockResolvedValue([]);

        const response = await call("s3cret");

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            ok: true,
            shops: 1,
            shopsFailed: 0,
            issues: 0,
            p1: 0,
            delivered: false,
        });
        expect(h.audit).toHaveBeenCalledTimes(1);
        expect(h.notify).not.toHaveBeenCalled();
    });

    it("发现 P1 → 发告警，并把 delivered 回传给调用方", async () => {
        h.sessions.mockResolvedValue([{ shop: "a.myshopify.com" }]);
        h.plan.mockResolvedValue("pro");
        h.admin.mockResolvedValue({ admin: {} });
        h.audit.mockResolvedValue([P1_ISSUE]);
        h.notify.mockResolvedValue({ delivered: true, skipped: false });

        const response = await call("s3cret");

        await expect(response.json()).resolves.toMatchObject({
            issues: 1,
            p1: 1,
            delivered: true,
        });
        expect(h.notify).toHaveBeenCalledTimes(1);
    });

    it("单店失败（token 被吊销）不中断其余店铺，仅计入 shopsFailed", async () => {
        h.sessions.mockResolvedValue([
            { shop: "bad.myshopify.com" },
            { shop: "good.myshopify.com" },
        ]);
        h.plan.mockResolvedValue("free");
        h.admin.mockImplementation(async (shop: string) => {
            if (String(shop).startsWith("bad")) throw new Error("token revoked");
            return { admin: {} };
        });
        h.audit.mockResolvedValue([]);

        const response = await call("s3cret");

        await expect(response.json()).resolves.toMatchObject({
            shops: 2,
            shopsFailed: 1,
            ok: true,
        });
        expect(h.audit).toHaveBeenCalledTimes(1);
    });
});