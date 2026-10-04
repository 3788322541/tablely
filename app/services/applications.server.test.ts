/**
 * 分销商申请读写单测（M11 / §15.1 / §15.2 / §十二 验收 8、25）
 *
 * 用**假 Prisma + 假 resolvePlan** 覆盖编排逻辑，不连库：
 *   · 提交：pending 去重（同店同邮箱只允许一条）；
 *   · 列表：待审批置顶、其余按时间倒序；
 *   · 审批：Free 拒写（`error.proRequired`）、Pro 通过只改状态、跨店行按不存在（`error.notFound`）；
 *   · 建议保留期：被拒 90 天后清理；
 *   · 合规：按 email / customerId 删除申请行，两标识都缺时不动数据。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, resolvePlanMock } = vi.hoisted(() => ({
    prismaMock: {
        wholesaleApplication: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
            count: vi.fn(),
            deleteMany: vi.fn(),
        },
    },
    resolvePlanMock: vi.fn(),
}));

vi.mock("../db.server", () => ({ default: prismaMock }));

vi.mock("./tables.server", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./tables.server")>();
    return { ...actual, resolvePlan: resolvePlanMock };
});

import {
    approveWholesaleApplication,
    createWholesaleApplication,
    listWholesaleApplications,
    purgeExpiredRejectedApplications,
    redactApplicationsByCustomer,
    REJECTED_RETENTION_DAYS,
    rejectWholesaleApplication,
    saveWholesaleApplicationNote,
} from "./applications.server";
import { isTablelyError } from "./tables.server";
import type { ApplicationPayload } from "../applications";

const SHOP = "tablely-dev.myshopify.com";

const PAYLOAD: ApplicationPayload = {
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "+8613800138000",
    country: "CN",
    email: "ada@example.com",
    company: "Ada Co",
    website: null,
    businessTypes: ["beauty"],
    brandExperience: "yes",
    channels: ["amazon"],
    monthlyVolume: "mid",
    message: null,
    privacyConsent: true,
    locale: "en",
};

const row = (over: Record<string, unknown> = {}) => ({
    id: "app_1",
    shop: SHOP,
    email: "ada@example.com",
    customerId: null,
    status: "pending",
    note: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    payload: PAYLOAD,
    ...over,
});

async function expectTablelyError(
    run: () => Promise<unknown>,
    key: string,
    field?: string,
) {
    try {
        await run();
        expect.unreachable("应当抛出 TablelyError");
    } catch (error) {
        expect(isTablelyError(error)).toBe(true);
        if (isTablelyError(error)) {
            expect(error.key).toBe(key);
            if (field) expect(error.field).toBe(field);
        }
    }
}

beforeEach(() => {
    vi.clearAllMocks();
    resolvePlanMock.mockResolvedValue("pro");
});

describe("createWholesaleApplication（提交）", () => {
    it("同店同邮箱无 pending 时落库为 pending", async () => {
        prismaMock.wholesaleApplication.findFirst.mockResolvedValue(null);
        prismaMock.wholesaleApplication.create.mockResolvedValue({ id: "app_new" });

        const created = await createWholesaleApplication({ shop: SHOP, payload: PAYLOAD });

        expect(created).toEqual({ id: "app_new" });
        expect(prismaMock.wholesaleApplication.findFirst).toHaveBeenCalledWith({
            where: { shop: SHOP, email: PAYLOAD.email, status: "pending" },
            select: { id: true },
        });
        expect(prismaMock.wholesaleApplication.create).toHaveBeenCalledTimes(1);
    });

    it("已有同邮箱 pending → 拒绝且不落库（§15.1 #5 去重）", async () => {
        prismaMock.wholesaleApplication.findFirst.mockResolvedValue({ id: "app_old" });

        await expectTablelyError(
            () => createWholesaleApplication({ shop: SHOP, payload: PAYLOAD }),
            "error.applicationDuplicate",
            "email",
        );
        expect(prismaMock.wholesaleApplication.create).not.toHaveBeenCalled();
    });
});

describe("listWholesaleApplications（列表）", () => {
    it("待审批置顶，其余按提交时间倒序", async () => {
        prismaMock.wholesaleApplication.findMany.mockResolvedValue([
            row({ id: "pending_old", status: "pending", createdAt: new Date("2026-10-01") }),
            row({ id: "approved_new", status: "approved", createdAt: new Date("2026-10-03") }),
            row({ id: "rejected_mid", status: "rejected", createdAt: new Date("2026-10-02") }),
        ]);

        const list = await listWholesaleApplications(SHOP);

        expect(list.map((item) => item.id)).toEqual([
            "pending_old",
            "approved_new",
            "rejected_mid",
        ]);
        expect(list[0].payload.email).toBe("ada@example.com");
    });
});

describe("审批动作（Pro 门控 + 租户隔离）", () => {
    it("Free 下审批被拒（error.proRequired），不写库", async () => {
        resolvePlanMock.mockResolvedValue("free");

        await expectTablelyError(
            () => approveWholesaleApplication({ shop: SHOP, id: "app_1" }),
            "error.proRequired",
        );
        expect(prismaMock.wholesaleApplication.updateMany).not.toHaveBeenCalled();
    });

    it("Pro 且行属于本店 → 只改状态为 approved，返回引导标签", async () => {
        prismaMock.wholesaleApplication.findFirst.mockResolvedValue({ id: "app_1" });
        prismaMock.wholesaleApplication.updateMany.mockResolvedValue({ count: 1 });

        const result = await approveWholesaleApplication({ shop: SHOP, id: "app_1" });

        expect(result).toEqual({ tag: "tablely-wholesale" });
        expect(prismaMock.wholesaleApplication.updateMany).toHaveBeenCalledWith({
            where: { id: "app_1", shop: SHOP },
            data: { status: "approved" },
        });
    });

    it("跨店 / 不存在的行按不存在处理（error.notFound）", async () => {
        prismaMock.wholesaleApplication.findFirst.mockResolvedValue(null);

        await expectTablelyError(
            () => approveWholesaleApplication({ shop: SHOP, id: "other_app" }),
            "error.notFound",
        );
        expect(prismaMock.wholesaleApplication.updateMany).not.toHaveBeenCalled();
        // 查询必须带 shop 条件（越权防护 §8.2 A）
        expect(prismaMock.wholesaleApplication.findFirst).toHaveBeenCalledWith({
            where: { id: "other_app", shop: SHOP },
            select: { id: true },
        });
    });

    it("拒绝：状态 rejected + 备注截断到 500", async () => {
        prismaMock.wholesaleApplication.findFirst.mockResolvedValue({ id: "app_1" });
        prismaMock.wholesaleApplication.updateMany.mockResolvedValue({ count: 1 });

        await rejectWholesaleApplication({
            shop: SHOP,
            id: "app_1",
            note: "x".repeat(600),
        });

        const call = prismaMock.wholesaleApplication.updateMany.mock.calls[0][0];
        expect(call.data.status).toBe("rejected");
        expect(call.data.note).toHaveLength(500);
    });

    it("备注：只写 note，不改状态", async () => {
        prismaMock.wholesaleApplication.findFirst.mockResolvedValue({ id: "app_1" });
        prismaMock.wholesaleApplication.updateMany.mockResolvedValue({ count: 1 });

        await saveWholesaleApplicationNote({ shop: SHOP, id: "app_1", note: "  follow up  " });

        expect(prismaMock.wholesaleApplication.updateMany).toHaveBeenCalledWith({
            where: { id: "app_1", shop: SHOP },
            data: { note: "follow up" },
        });
    });
});

describe("保留期清理（§8.1：被拒 90 天）", () => {
    it("按 shop + rejected + 早于 90 天清理", async () => {
        prismaMock.wholesaleApplication.deleteMany.mockResolvedValue({ count: 2 });
        const now = new Date("2026-10-04T00:00:00Z");

        const deleted = await purgeExpiredRejectedApplications(SHOP, now);

        expect(deleted).toBe(2);
        const call = prismaMock.wholesaleApplication.deleteMany.mock.calls[0][0];
        expect(call.where.shop).toBe(SHOP);
        expect(call.where.status).toBe("rejected");
        const expectedCutoff = new Date(
            now.getTime() - REJECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        );
        expect(call.where.createdAt.lt).toEqual(expectedCutoff);
    });
});

describe("合规删除（customers/redact）", () => {
    it("有 email → 按 OR(email, customerId) 删除", async () => {
        prismaMock.wholesaleApplication.deleteMany.mockResolvedValue({ count: 1 });

        const deleted = await redactApplicationsByCustomer({
            shop: SHOP,
            email: "Ada@Example.com",
            customerId: "42",
        });

        expect(deleted).toBe(1);
        expect(prismaMock.wholesaleApplication.deleteMany).toHaveBeenCalledWith({
            where: {
                shop: SHOP,
                OR: [{ email: "ada@example.com" }, { customerId: "42" }],
            },
        });
    });

    it("两个标识都缺 → 不动任何数据（不误删整店）", async () => {
        const deleted = await redactApplicationsByCustomer({ shop: SHOP });
        expect(deleted).toBe(0);
        expect(prismaMock.wholesaleApplication.deleteMany).not.toHaveBeenCalled();
    });
});