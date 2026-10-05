/**
 * 加购上报接口单测（M13 / §十五 A3 / §十二 验收 26）
 *
 * 核心红线：**任何失败一律返 204，绝不阻塞加购**；跨店域名静默丢弃不落库；
 * 未登录顾客 `customerId` 落 null（不进历史列表）；`source` 非白名单回退 `table`。
 *
 * 放在 `services/`（与 `appProxy.route.test.ts` 同法）：`app/routes/` 下的 `.test.ts`
 * 会被 flat routes 当成路由模块，构建时报「loader 未导出」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();

vi.mock("../db.server", () => ({
    default: {
        shopSettings: {
            findUnique: (...args: unknown[]) => findUnique(...args),
            updateMany: (...args: unknown[]) => updateMany(...args),
        },
        addToCartEvent: { create: (...args: unknown[]) => create(...args) },
    },
}));

vi.mock("../services/monitor.server", () => ({ logStructured: vi.fn() }));

import { action, loader } from "../routes/api.addtocart";

function post(body: string, method = "POST") {
    // GET / HEAD 不允许携带 body（Web 规范），仅方法本身即可触发分支
    const init: RequestInit = { method };
    if (method !== "GET" && method !== "HEAD") init.body = body;
    return new Request("https://tablely.zhenjunit.com/api/addtocart", init);
}

const validBody = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
        shop: "s.myshopify.com",
        productId: "111",
        variantId: "222",
        quantity: 5,
        rows: 3,
        customerId: "9",
        source: "reorder",
        ...overrides,
    });

beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
    updateMany.mockReset();
    findUnique.mockResolvedValue({ id: "s1", firstAddToCart: new Date() });
    create.mockResolvedValue({});
    updateMany.mockResolvedValue({ count: 0 });
});

describe("api.addtocart — 方法与载荷校验", () => {
    it("loader（GET）→ 405", () => {
        expect(loader().status).toBe(405);
    });

    it("OPTIONS 预检 → 204", async () => {
        expect((await action({ request: post("", "OPTIONS") } as never)).status).toBe(204);
    });

    it("非 POST → 405", async () => {
        expect((await action({ request: post("", "GET") } as never)).status).toBe(405);
    });

    it("非法 JSON → 400", async () => {
        expect((await action({ request: post("{not json") } as never)).status).toBe(400);
    });

    it("缺 shop / variantId 非纯数字 → 400", async () => {
        expect((await action({ request: post(validBody({ shop: "" })) } as never)).status).toBe(400);
        expect((await action({ request: post(validBody({ variantId: "abc" })) } as never)).status).toBe(400);
    });

    it("quantity / rows 非正整数 → 400", async () => {
        expect((await action({ request: post(validBody({ quantity: 0 })) } as never)).status).toBe(400);
        expect((await action({ request: post(validBody({ rows: 0 })) } as never)).status).toBe(400);
    });
});

describe("api.addtocart — 落库与归属", () => {
    it("店铺未在 ShopSettings 中 → 204 且不落库（静默丢弃）", async () => {
        findUnique.mockResolvedValue(null);
        expect((await action({ request: post(validBody()) } as never)).status).toBe(204);
        expect(create).not.toHaveBeenCalled();
    });

    it("合法载荷 → 落库，字段归一化（source 白名单 / customerId 数字）", async () => {
        const res = await action({ request: post(validBody()) } as never);
        expect(res.status).toBe(204);
        expect(create).toHaveBeenCalledWith({
            data: {
                shop: "s.myshopify.com",
                productId: "111",
                variantId: "222",
                quantity: 5,
                rows: 3,
                source: "reorder",
                customerId: "9",
            },
        });
    });

    it("未登录（customerId 非数字）→ 落 null", async () => {
        await action({ request: post(validBody({ customerId: "" })) } as never);
        expect(create.mock.calls[0][0].data.customerId).toBeNull();
    });

    it("source 非白名单 → 回退 table", async () => {
        await action({ request: post(validBody({ source: "hacked" })) } as never);
        expect(create.mock.calls[0][0].data.source).toBe("table");
    });

    it("首次加购：firstAddToCart 为空 → 条件更新一次", async () => {
        findUnique.mockResolvedValue({ id: "s1", firstAddToCart: null });
        await action({ request: post(validBody()) } as never);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany.mock.calls[0][0].where).toEqual({
            shop: "s.myshopify.com",
            firstAddToCart: null,
        });
    });

    it("已有首次时间戳 → 不再更新（二次触发不覆盖）", async () => {
        await action({ request: post(validBody()) } as never);
        expect(updateMany).not.toHaveBeenCalled();
    });
});

describe("api.addtocart — 失败绝不阻塞", () => {
    it("落库抛错仍返 204（fire-and-forget）", async () => {
        create.mockRejectedValue(new Error("db down"));
        expect((await action({ request: post(validBody()) } as never)).status).toBe(204);
    });
});