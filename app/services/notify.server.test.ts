import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./monitor.server", () => ({ logStructured: vi.fn() }));

import { feishuSign, formatIntegrityReport, notifyDeveloper } from "./notify.server";

const FEISHU_URL = "https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000";
const ENV_KEYS = ["ALERT_WEBHOOK_URL", "ALERT_WEBHOOK_SECRET"] as const;

afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    vi.unstubAllGlobals();
});

describe("feishuSign（§21.5 告警通道）", () => {
    it("固定向量：key = `${timestamp}\\n${secret}`、消息体为空", () => {
        expect(feishuSign("test-secret", "1791294597")).toBe(
            "QCGYVpqpi9CaAzl/8tTqsz/tg8K3tFgtRWp6Bzg+2Eg=",
        );
    });

    it("回归护栏：与「key=secret / msg=timestamp+secret」的错误写法不同（19021 陷阱）", () => {
        expect(feishuSign("test-secret", "1791294597")).not.toBe(
            "N21s8hhVjBTXdKfqdPVr1T6YEVnKz/UP2n6fCb3YDRs=",
        );
    });
});

describe("notifyDeveloper", () => {
    it("未配置 ALERT_WEBHOOK_URL → skipped，且根本不发请求", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(notifyDeveloper("hi")).resolves.toEqual({
            delivered: false,
            skipped: true,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("飞书：code=0 才算送达，payload 带 msg_type / content / sign / timestamp", async () => {
        process.env.ALERT_WEBHOOK_URL = FEISHU_URL;
        process.env.ALERT_WEBHOOK_SECRET = "test-secret";
        const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe(FEISHU_URL);
            expect(init.method).toBe("POST");
            return new Response(JSON.stringify({ code: 0 }), { status: 200 });
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(notifyDeveloper("hi")).resolves.toEqual({
            delivered: true,
            skipped: false,
        });

        const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
        expect(body.msg_type).toBe("text");
        expect(body.content).toEqual({ text: "hi" });
        expect(typeof body.sign).toBe("string");
        expect(body.timestamp).toMatch(/^\d+$/);
    });

    it("飞书：HTTP 200 但 code≠0 → 视为未送达", async () => {
        process.env.ALERT_WEBHOOK_URL = FEISHU_URL;
        process.env.ALERT_WEBHOOK_SECRET = "test-secret";
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(JSON.stringify({ code: 19021 }), { status: 200 })),
        );

        await expect(notifyDeveloper("hi")).resolves.toEqual({
            delivered: false,
            skipped: false,
        });
    });

    it("网络异常 → 不抛错，只返回未送达（巡检不能被告警通道拖垮）", async () => {
        process.env.ALERT_WEBHOOK_URL = FEISHU_URL;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("boom");
            }),
        );

        await expect(notifyDeveloper("hi")).resolves.toEqual({
            delivered: false,
            skipped: false,
        });
    });
});

describe("formatIntegrityReport", () => {
    it("按 P1 / P2 分组，带店铺与问题码", () => {
        const text = formatIntegrityReport(
            [
                {
                    shop: "a.myshopify.com",
                    code: "discount_deleted",
                    severity: "P1",
                    detail: "阶梯价折扣 123 在店铺中已不存在",
                },
                {
                    shop: "b.myshopify.com",
                    code: "discount_active_on_free",
                    severity: "P2",
                    detail: "非 Pro 店折扣仍为 active（降级未生效）",
                },
            ],
            2,
        );

        expect(text).toContain("P1 1 / P2 1");
        expect(text).toContain("P1 立即处理（1）");
        expect(text).toContain("a.myshopify.com | discount_deleted | 阶梯价折扣 123 在店铺中已不存在");
        expect(text).toContain("P2 工作日处理（1）");
        expect(text).toContain("b.myshopify.com | discount_active_on_free");
    });
});