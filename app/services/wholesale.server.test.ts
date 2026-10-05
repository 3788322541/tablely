/**
 * Wholesale 单测（M10 / M12）—— 门控配置 / 客户组 CRUD / 标签迁移 / 门控判定 / 档位校验
 *
 * 与 `tables.gating.test.ts` 同一取证方式：假 Prisma（`vi.hoisted` + `vi.mock`）验证
 * 「后端双保险」与「改名后批发价仍生效」这两条 M10 验收口径；并另对**真实 Liquid 文本**
 * 做静态断言，覆盖店面门控（无头浏览器禁用，无法运行时取证）。
 *
 * 覆盖：
 *   · 纯函数：`normalizeTags` / `normalizeGateMode` / `gateDecision` / `collectTagOptions`；
 *   · 门控配置：Free 拒写；非 off 且无标签拒写；Pro 写库 + 下发 metafield；
 *   · 客户组：Free 拒写；名称 / 标签归一化校验；标签唯一；
 *   · **改标签 → 同事务迁移 `WholesalePrice.groupTag`**（M10 验收 ②）；
 *   · 删除 → 同事务删批发价行并返回影响条数；
 *   · **档位校验（M12）**：`normalizeTierModel` 白名单回退 / `validateTierRows` 排序去重与四条错误路径；
 *   · Liquid 门控：`hide_table` 整表不渲染 / `hide_price` 不输出价格衍生（§2.8）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        planState: { findUnique: vi.fn() },
        shopSettings: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
        customerGroup: {
            findUnique: vi.fn(),
            findFirst: vi.fn(),
            findMany: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
        },
        wholesalePrice: {
            groupBy: vi.fn(),
            updateMany: vi.fn(),
            deleteMany: vi.fn(),
        },
        $transaction: vi.fn(),
    },
}));

vi.mock("../db.server", () => ({ default: prismaMock }));
vi.mock("./settings.server", () => ({
    ensureShopSettings: vi.fn(),
    pushShopSettingsMetafield: vi.fn(),
}));

import { ensureShopSettings, pushShopSettingsMetafield } from "./settings.server";
import { TablelyError, isTablelyError } from "./tables.server";
import {
    collectTagOptions,
    createCustomerGroup,
    deleteCustomerGroup,
    gateDecision,
    getGateSettings,
    listCustomerGroups,
    normalizeGateMode,
    normalizeTags,
    normalizeTierModel,
    saveGateSettings,
    updateCustomerGroup,
    validateTierRows,
} from "./wholesale.server";
import type { GraphqlAdmin } from "./metafield.server";

const SHOP = "tablely-dev.myshopify.com";

const free = () => prismaMock.planState.findUnique.mockResolvedValue({ plan: "free" });
const pro = () => prismaMock.planState.findUnique.mockResolvedValue({ plan: "pro" });

const ensureMock = vi.mocked(ensureShopSettings);
const pushMock = vi.mocked(pushShopSettingsMetafield);

const dummyAdmin = { graphql: vi.fn() } as unknown as GraphqlAdmin;

const expectKey = async (run: () => unknown | Promise<unknown>, key: string, field?: string | null) => {
    try {
        await run();
        throw new Error(`应当抛错 ${key}`);
    } catch (error) {
        expect(isTablelyError(error)).toBe(true);
        expect((error as TablelyError).key).toBe(key);
        if (field !== undefined) expect((error as TablelyError).field).toBe(field);
    }
};

beforeEach(() => {
    vi.clearAllMocks();
    free();
    ensureMock.mockResolvedValue({ gateMode: "off", gateTags: [] } as never);
    pushMock.mockResolvedValue(undefined as never);
    prismaMock.shopSettings.update.mockResolvedValue({});
    prismaMock.customerGroup.findMany.mockResolvedValue([]);
    prismaMock.customerGroup.findUnique.mockResolvedValue(null);
    prismaMock.customerGroup.findFirst.mockResolvedValue(null);
    prismaMock.wholesalePrice.groupBy.mockResolvedValue([]);
    prismaMock.wholesalePrice.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.wholesalePrice.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn(prismaMock),
    );
});

/* ============================== 纯函数 ============================== */

describe("normalizeTags", () => {
    it("trim / 去空 / 去重（保留首次出现顺序），丢弃非字符串", () => {
        expect(normalizeTags([" b ", "a", "a", "", "   ", 1, null, "b"])).toEqual(["b", "a"]);
    });
});

describe("normalizeGateMode", () => {
    it("白名单内原样返回", () => {
        expect(normalizeGateMode("off")).toBe("off");
        expect(normalizeGateMode("hide_price")).toBe("hide_price");
        expect(normalizeGateMode("hide_table")).toBe("hide_table");
    });

    it("非白名单 / 脏值退回 off（不把脏值写进契约）", () => {
        expect(normalizeGateMode("hide_all")).toBe("off");
        expect(normalizeGateMode(undefined)).toBe("off");
        expect(normalizeGateMode(42)).toBe("off");
    });
});

describe("gateDecision（§1.4 #19 / §16.4）", () => {
    const cases: Array<{
        label: string;
        input: Parameters<typeof gateDecision>[0];
        want: ReturnType<typeof gateDecision>;
    }> = [
            {
                label: "off → 所有人可见",
                input: { mode: "off", tags: [], customerTags: [], loggedIn: false },
                want: "show",
            },
            {
                label: "hide_price + 命中标签 + 已登录 → 可见",
                input: {
                    mode: "hide_price",
                    tags: ["vip"],
                    customerTags: ["vip"],
                    loggedIn: true,
                },
                want: "show",
            },
            {
                label: "hide_price + 未命中 → 只隐藏价",
                input: { mode: "hide_price", tags: ["vip"], customerTags: [], loggedIn: true },
                want: "price_hidden",
            },
            {
                label: "hide_price + 命中标签但未登录 → 仍不合格",
                input: {
                    mode: "hide_price",
                    tags: ["vip"],
                    customerTags: ["vip"],
                    loggedIn: false,
                },
                want: "price_hidden",
            },
            {
                label: "hide_table + 未命中 → 整表隐藏",
                input: { mode: "hide_table", tags: ["vip"], customerTags: [], loggedIn: true },
                want: "table_hidden",
            },
            {
                label: "hide_table + 命中标签 + 已登录 → 可见",
                input: {
                    mode: "hide_table",
                    tags: ["vip", "wholesale"],
                    customerTags: ["wholesale"],
                    loggedIn: true,
                },
                want: "show",
            },
            {
                label: "非 off 但合格标签为空 → 无人合格（兜底隐藏）",
                input: { mode: "hide_price", tags: [], customerTags: ["vip"], loggedIn: true },
                want: "price_hidden",
            },
        ];

    for (const c of cases) {
        it(c.label, () => expect(gateDecision(c.input)).toBe(c.want));
    }
});

describe("collectTagOptions", () => {
    it("已保存门控标签 ∪ 现有客户组标签，去重保序", () => {
        const options = collectTagOptions(
            { mode: "off", tags: ["a"] },
            [
                { id: "1", name: "g", tag: "b", note: null, sortOrder: 1, priceCount: 0 },
                { id: "2", name: "h", tag: "a", note: null, sortOrder: 2, priceCount: 0 },
            ],
        );
        expect(options).toEqual(["a", "b"]);
    });

    it("门控标签与客户组解耦：改 / 删客户组不影响已保存的 gateTags", () => {
        // 已保存门控标签 "vip" 不在任何现有客户组里，仍须保留（避免改组把门控悄悄清空）
        const options = collectTagOptions({ mode: "hide_price", tags: ["vip"] }, []);
        expect(options).toEqual(["vip"]);
    });
});

/* ============================== 门控配置 ============================== */

describe("getGateSettings", () => {
    it("读行并归一化（脏模式退回 off）", async () => {
        ensureMock.mockResolvedValue({ gateMode: "hide_table", gateTags: [" x ", "", "x"] } as never);
        expect(await getGateSettings(SHOP)).toEqual({ mode: "hide_table", tags: ["x"] });
    });
});

describe("saveGateSettings", () => {
    it("Free → error.proRequired，不写库", async () => {
        await expectKey(
            () => saveGateSettings({ admin: dummyAdmin, shop: SHOP, mode: "hide_price", tags: ["vip"] }),
            "error.proRequired",
        );
        expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
    });

    it("非 off 且无合格标签 → error.gateTagsRequired（field=gateTags）", async () => {
        pro();
        await expectKey(
            () => saveGateSettings({ admin: dummyAdmin, shop: SHOP, mode: "hide_table", tags: ["  "] }),
            "error.gateTagsRequired",
            "gateTags",
        );
        expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
    });

    it("Pro + off（无标签合法）→ 写库并下发 metafield", async () => {
        pro();
        const saved = await saveGateSettings({ admin: dummyAdmin, shop: SHOP, mode: "off", tags: [] });
        expect(saved).toEqual({ mode: "off", tags: [] });
        expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
            where: { shop: SHOP },
            data: { gateMode: "off", gateTags: [] },
        });
        expect(pushMock).toHaveBeenCalledWith({ admin: dummyAdmin, shop: SHOP });
    });

    it("Pro + hide_price + 标签去重去空 → 写库", async () => {
        pro();
        const saved = await saveGateSettings({
            admin: dummyAdmin,
            shop: SHOP,
            mode: "hide_price",
            tags: ["vip", "vip", " "],
        });
        expect(saved).toEqual({ mode: "hide_price", tags: ["vip"] });
        expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
            where: { shop: SHOP },
            data: { gateMode: "hide_price", gateTags: ["vip"] },
        });
    });
});

/* ============================== 客户组 ============================== */

describe("createCustomerGroup", () => {
    it("Free → error.proRequired", async () => {
        await expectKey(
            () => createCustomerGroup({ shop: SHOP, name: "一级代理", tag: "vip" }),
            "error.proRequired",
        );
        expect(prismaMock.customerGroup.create).not.toHaveBeenCalled();
    });

    it("名称为空 → error.groupNameRequired（field=name）", async () => {
        pro();
        await expectKey(
            () => createCustomerGroup({ shop: SHOP, name: "  ", tag: "vip" }),
            "error.groupNameRequired",
            "name",
        );
    });

    it("标签含空格 → error.groupTagInvalid（field=tag）", async () => {
        pro();
        await expectKey(
            () => createCustomerGroup({ shop: SHOP, name: "g", tag: "v ip" }),
            "error.groupTagInvalid",
            "tag",
        );
    });

    it("标签已被占用 → error.groupTagTaken", async () => {
        pro();
        prismaMock.customerGroup.findUnique.mockResolvedValue({ id: "other" });
        await expectKey(
            () => createCustomerGroup({ shop: SHOP, name: "g", tag: "vip" }),
            "error.groupTagTaken",
        );
    });

    it("Pro 正常创建：sortOrder 递增、备注留空归一为 null", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue({ sortOrder: 4 });
        prismaMock.customerGroup.create.mockResolvedValue({
            id: "g1",
            name: "一级代理",
            tag: "vip",
            note: null,
            sortOrder: 5,
        });
        const created = await createCustomerGroup({
            shop: SHOP,
            name: " 一级代理 ",
            tag: " vip ",
            note: "   ",
        });
        expect(prismaMock.customerGroup.create).toHaveBeenCalledWith({
            data: { shop: SHOP, name: "一级代理", tag: "vip", note: null, sortOrder: 5 },
        });
        expect(created).toEqual({
            id: "g1",
            name: "一级代理",
            tag: "vip",
            note: null,
            sortOrder: 5,
            priceCount: 0,
        });
    });
});

describe("updateCustomerGroup", () => {
    const existing = {
        id: "g1",
        name: "一级代理",
        tag: "vip",
        note: null,
        sortOrder: 1,
    };

    it("不存在 → error.notFound", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue(null);
        await expectKey(
            () => updateCustomerGroup({ shop: SHOP, id: "g1", name: "x", tag: "y" }),
            "error.notFound",
        );
    });

    it("改标签 → 同一事务内迁移 WholesalePrice.groupTag（M10 验收 ②）", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue(existing);
        prismaMock.customerGroup.update.mockResolvedValue({});
        await updateCustomerGroup({
            shop: SHOP,
            id: "g1",
            name: "一级代理",
            tag: "vvip",
            note: "",
        });
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
        expect(prismaMock.wholesalePrice.updateMany).toHaveBeenCalledWith({
            where: { shop: SHOP, groupTag: "vip" },
            data: { groupTag: "vvip" },
        });
        expect(prismaMock.customerGroup.update).toHaveBeenCalledWith({
            where: { id: "g1" },
            data: { name: "一级代理", tag: "vvip", note: null },
        });
    });

    it("标签未变 → 不触发批发价迁移（只改名称 / 备注）", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue(existing);
        prismaMock.customerGroup.update.mockResolvedValue({});
        await updateCustomerGroup({
            shop: SHOP,
            id: "g1",
            name: "一级代理（改）",
            tag: "vip",
            note: "备注",
        });
        expect(prismaMock.wholesalePrice.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.customerGroup.update).toHaveBeenCalledWith({
            where: { id: "g1" },
            data: { name: "一级代理（改）", tag: "vip", note: "备注" },
        });
    });

    it("新标签撞其他组 → error.groupTagTaken", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue(existing);
        prismaMock.customerGroup.findUnique.mockResolvedValue({ id: "other" });
        await expectKey(
            () => updateCustomerGroup({ shop: SHOP, id: "g1", name: "a", tag: "vvip" }),
            "error.groupTagTaken",
        );
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it("返回迁移后的引用计数", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue(existing);
        prismaMock.customerGroup.update.mockResolvedValue({});
        prismaMock.wholesalePrice.groupBy.mockResolvedValue([
            { groupTag: "vvip", _count: { _all: 3 } },
        ]);
        const record = await updateCustomerGroup({
            shop: SHOP,
            id: "g1",
            name: "一级代理",
            tag: "vvip",
        });
        expect(record.priceCount).toBe(3);
    });
});

describe("deleteCustomerGroup", () => {
    it("不存在 → error.notFound", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue(null);
        await expectKey(
            () => deleteCustomerGroup({ shop: SHOP, id: "g1" }),
            "error.notFound",
        );
    });

    it("同一事务内先删批发价行、再删组，并返回影响条数", async () => {
        pro();
        prismaMock.customerGroup.findFirst.mockResolvedValue({
            id: "g1",
            name: "一级代理",
            tag: "vip",
            note: null,
            sortOrder: 1,
        });
        prismaMock.wholesalePrice.deleteMany.mockResolvedValue({ count: 2 });
        prismaMock.customerGroup.delete.mockResolvedValue({});
        const result = await deleteCustomerGroup({ shop: SHOP, id: "g1" });
        expect(result).toEqual({ deletedPrices: 2 });
        expect(prismaMock.wholesalePrice.deleteMany).toHaveBeenCalledWith({
            where: { shop: SHOP, groupTag: "vip" },
        });
        expect(prismaMock.customerGroup.delete).toHaveBeenCalledWith({ where: { id: "g1" } });
    });
});

describe("listCustomerGroups", () => {
    it("附各组被引用的批发价行数", async () => {
        prismaMock.customerGroup.findMany.mockResolvedValue([
            { id: "g1", name: "一", tag: "vip", note: null, sortOrder: 1, createdAt: new Date() },
            { id: "g2", name: "二", tag: "vvip", note: "n", sortOrder: 2, createdAt: new Date() },
        ]);
        prismaMock.wholesalePrice.groupBy.mockResolvedValue([
            { groupTag: "vip", _count: { _all: 2 } },
        ]);
        const list = await listCustomerGroups(SHOP);
        expect(list.map((g) => g.priceCount)).toEqual([2, 0]);
        expect(list.map((g) => g.tag)).toEqual(["vip", "vvip"]);
    });
});

/* ================= 店面门控（真实 Liquid 文本静态断言） ================= */

const EXT = join(process.cwd(), "extensions", "tablely-order-table");
function readLiquid(relative: string): string {
    return readFileSync(join(EXT, relative), "utf8");
}
function stripLiquidComments(code: string): string {
    return code.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

describe("店面门控 Liquid（M10 验收 ①）", () => {
    const block = stripLiquidComments(readLiquid("blocks/order-table.liquid"));
    const markup = stripLiquidComments(readLiquid("snippets/table-markup.liquid"));

    it("按登录态 + customer.tags 实时判定（含 hide_table / hide_price 分支）", () => {
        expect(block).toContain("customer.tags");
        expect(block).toContain("tly_allowed contains tly_tag");
        expect(block).toMatch(/tly_gate_mode\s*==\s*'hide_table'/);
        expect(block).toContain("tly_price_hidden");
    });

    it("hide_table → tly_show=false，整块不渲染（table-style 也随之不输出 → hideNative 失效、原生加购保留）", () => {
        // 门控赋值必须发生在 `{%- if tly_show -%}` 输出块之前
        const gateIndex = block.indexOf("tly_gate_mode");
        const showIndex = block.indexOf("{%- if tly_show -%}");
        expect(gateIndex).toBeGreaterThan(-1);
        expect(showIndex).toBeGreaterThan(gateIndex);
        expect(block).toMatch(/assign tly_show = false/);
    });

    it("隐藏价标志显式传入 table-markup（render 为隔离作用域）", () => {
        expect(block).toContain("tly_price_hidden: tly_price_hidden");
    });

    it("hide_price → 关闭价格列、不输出 data-price / 合计 / 起订金额门槛（§2.8）", () => {
        // 三处行上的 data-price 都被门控包住
        const priceAttrs = markup.match(/unless tly_price_hidden %\} data-price=/g) ?? [];
        expect(priceAttrs.length).toBe(3);
        // 合计与门控阈值同样受控
        expect(markup).toMatch(/if tly_price_hidden[\s\S]*?assign col_price = false/);
        expect(markup).toMatch(/unless tly_price_hidden -%\}\s*<span class="tablely-summary-text"/);
    });

    it("清空 tly_min 让 data-tablely-order-min 与起订金额块一并消失（避免合计恒 0 永久禁用提交）", () => {
        expect(markup).toMatch(/if tly_price_hidden[\s\S]*?assign tly_min = ''/);
    });
});

/* ============================ 档位校验（M12） ============================ */

describe("validateTierRows / normalizeTierModel（M12 / §16.2）", () => {
    it("模型归一化：非白名单退回 percent（不把脏值写进契约）", () => {
        expect(normalizeTierModel("fixed")).toBe("fixed");
        expect(normalizeTierModel("percent")).toBe("percent");
        expect(normalizeTierModel("bogus")).toBe("percent");
        expect(normalizeTierModel(null)).toBe("percent");
    });

    it("percent 模型：整行留空跳过、按 qty 升序、同 qty 后者覆盖", () => {
        const rows = validateTierRows(
            [
                { qty: "", percent: "", price: "" },
                { qty: "10", percent: "10" },
                { qty: "5", percent: "5" },
                { qty: "10", percent: "12" },
            ],
            "percent",
        );
        expect(rows).toEqual([
            { qty: 5, percent: 5 },
            { qty: 10, percent: 12 },
        ]);
    });

    it("fixed 模型：价格串通过校验并按 qty 升序", () => {
        const rows = validateTierRows(
            [{ qty: "2", price: "95.00" }, { qty: "1", price: "99" }],
            "fixed",
        );
        expect(rows).toEqual([
            { qty: 1, price: "99" },
            { qty: 2, price: "95.00" },
        ]);
    });

    it("非法 qty（0 / 非整数）→ error.tierQtyInvalid", async () => {
        await expectKey(
            () => validateTierRows([{ qty: "0", percent: "5" }], "percent"),
            "error.tierQtyInvalid",
            "tierQty",
        );
        await expectKey(
            () => validateTierRows([{ qty: "1.5", percent: "5" }], "percent"),
            "error.tierQtyInvalid",
            "tierQty",
        );
    });

    it("percent 越界（0 / >100 / 非数字）→ error.tierPercentInvalid", async () => {
        await expectKey(
            () => validateTierRows([{ qty: "3", percent: "0" }], "percent"),
            "error.tierPercentInvalid",
            "tierPercent",
        );
        await expectKey(
            () => validateTierRows([{ qty: "3", percent: "101" }], "percent"),
            "error.tierPercentInvalid",
            "tierPercent",
        );
    });

    it("fixed 价格串越界（多小数位 / 超 8 位整数 / 非数字）→ error.tierPriceInvalid", async () => {
        await expectKey(
            () => validateTierRows([{ qty: "3", price: "9.999" }], "fixed"),
            "error.tierPriceInvalid",
            "tierPrice",
        );
        await expectKey(
            () => validateTierRows([{ qty: "3", price: "123456789" }], "fixed"),
            "error.tierPriceInvalid",
            "tierPrice",
        );
        await expectKey(
            () => validateTierRows([{ qty: "3", price: "abc" }], "fixed"),
            "error.tierPriceInvalid",
            "tierPrice",
        );
    });

    it("档位 JSON 超上限 → error.tierTooLarge（不静默截断）", async () => {
        const wide = Array.from({ length: 600 }, (_item, index) => ({
            qty: String(index + 1),
            price: "1.00",
        }));
        await expectKey(() => validateTierRows(wide, "fixed"), "error.tierTooLarge");
    });
});