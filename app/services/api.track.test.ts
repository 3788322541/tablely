/**
 * App Block 渲染上报接口单测（M14 / Y1 激活漏斗 `blockAddedAt`）
 *
 * 红线：与 `api.addtocart` 同套路 —— **任何失败一律返 204**，绝不干扰店面；
 * 未登记店铺静默丢弃；`blockAddedAt` **首次写入后不再覆盖**。
 *
 * 放在 `services/`：`app/routes/` 下的 `.test.ts` 会被 flat routes 当成路由模块。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();

vi.mock("../db.server", () => ({
    default: {
        shopSettings: {
            findUnique: (...args: unknown[]) => findUnique(...args),
            updateMany: (...args: unknown[]) => updateMany(...args),
        },
    },
}));

vi.mock("../services/monitor.server", () => ({ logStructured: vi.fn() }));

import { action, loader } from "../routes/api.track";

function post(body: string, method = "POST") {
    const init: RequestInit = { method };
    if (method !== "GET" && method !== "HEAD") init.body = body;
    return new Request("https://tablely.zhenjunit.com/api/track", init);
}

const body = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ shop: "s.myshopify.com", ...overrides });

beforeEach(() => {
    findUnique.mockReset();
    updateMany.mockReset();
    findUnique.mockResolvedValue({ id: "s1", blockAddedAt: null });
    updateMany.mockResolvedValue({ count: 1 });
});

describe("api.track — 方法与载荷", () => {
    it("loader（GET）→ 405", () => {
        expect(loader().status).toBe(405);
    });

    it("OPTIONS 预检 → 204", async () => {
        expect((await action({ request: post("", "OPTIONS") } as never)).status).toBe(204);
    });

    it("非 POST → 405", async () => {
        expect((await action({ request: post("", "GET") } as never)).status).toBe(405);
    });

    it("非法 JSON → 204 且不查库（统计失败不报错）", async () => {
        const res = await action({ request: post("{not json") } as never);
        expect(res.status).toBe(204);
        expect(findUnique).not.toHaveBeenCalled();
    });

    it("缺 shop → 204 且不查库", async () => {
        const res = await action({ request: post(body({ shop: "  " })) } as never);
        expect(res.status).toBe(204);
        expect(findUnique).not.toHaveBeenCalled();
    });
});

describe("api.track — 落库与归属", () => {
    it("未登记店铺 → 204 且不更新", async () => {
        findUnique.mockResolvedValue(null);
        expect((await action({ request: post(body()) } as never)).status).toBe(204);
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("首次渲染：blockAddedAt 为空 → 条件更新一次", async () => {
        await action({ request: post(body()) } as never);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany.mock.calls[0][0].where).toEqual({
            shop: "s.myshopify.com",
            blockAddedAt: null,
        });
    });

    it("已记录 → 不再更新（二次触发不覆盖）", async () => {
        findUnique.mockResolvedValue({ id: "s1", blockAddedAt: new Date() });
        await action({ request: post(body()) } as never);
        expect(updateMany).not.toHaveBeenCalled();
    });
});

describe("api.track — 失败绝不阻塞", () => {
    it("查库抛错仍返 204（fire-and-forget）", async () => {
        findUnique.mockRejectedValue(new Error("db down"));
        expect((await action({ request: post(body()) } as never)).status).toBe(204);
    });

    it("更新抛错仍返 204", async () => {
        updateMany.mockRejectedValue(new Error("db down"));
        expect((await action({ request: post(body()) } as never)).status).toBe(204);
    });
});
