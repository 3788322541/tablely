/**
 * 店面运行时单测（M5，§五 反馈规则 / §16.6 Y14）
 *
 * `extensions/tablely-order-table/assets/tablely.js` 是**主题资产**（无模块系统，
 * 直接随商品页下发），没法被 vitest `import`。这里把它丢进一个 `node:vm` 沙箱执行，
 * 通过它自己的单测钩子（`window.__TABLELY_TEST__`，浏览器里恒不存在）取回纯函数。
 *
 * 覆盖的正是 M5 最容易出事的两处（§十三 风险表「显示达标却被拦」）：
 *   · 合计与起订金额的**金额口径**（格式串、分/元换算、是否同源）；
 *   · 提交前的**行级校验**（起订量 / 步长 / 库存 / 上限 / 缺货）与步进取值。
 * 真实 DOM 上的行为（AJAX、live region、禁用态）不在这里测 —— 那是 e2e 的事（§21.1）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

type RowError = { key: string; vars?: Record<string, string | number> } | null;

type Runtime = {
    makeT: (dict: Record<string, string>) => (key: string, vars?: Record<string, unknown>) => string;
    formatMoney: (cents: number, format?: string) => string;
    toCents: (value: unknown) => number | null;
    rowError: (row: unknown) => RowError;
    nextQuantity: (
        current: number,
        direction: number,
        bounds: { min: number; max: number | null; step: number },
    ) => number;
    computeTotals: (form: unknown) => { rows: number; units: number; cents: number };
    prefillQuantity: (
        recorded: number,
        bounds: { min: number; max: number | null; step: number },
    ) => number;
};

const ASSET = join(
    process.cwd(),
    "extensions",
    "tablely-order-table",
    "assets",
    "tablely.js",
);

/** 在沙箱里执行店面运行时，取回挂了纯函数的单测钩子 */
function loadRuntime(): Runtime {
    const hook: Partial<Runtime> = {};
    const sandbox = {
        window: { __TABLELY_TEST__: hook, setTimeout: () => 0 },
        document: {
            readyState: "complete",
            getElementById: () => null,
            addEventListener: () => { },
            querySelectorAll: () => [],
            dispatchEvent: () => { },
        },
        console,
    };
    createContext(sandbox);
    runInContext(readFileSync(ASSET, "utf8"), sandbox);
    if (!hook.formatMoney || !hook.rowError) {
        throw new Error("未能从 tablely.js 取到单测钩子（钩子被删或改名？）");
    }
    return hook as Runtime;
}

const runtime = loadRuntime();

/** 假的行元素：`attrs` 对应 Liquid 输出的 data-*，`qty` 是数量输入框的值 */
function fakeRow(
    attrs: Record<string, string> = {},
    qty = "0",
): {
    getAttribute: (name: string) => string | null;
    querySelector: (selector: string) => { value: string } | null;
} {
    return {
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        querySelector: (selector) =>
            selector === ".tablely-qty" ? { value: qty } : null,
    };
}

function fakeForm(attrs: Record<string, string>, rows: unknown[]) {
    return {
        getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
        querySelectorAll: (selector: string) =>
            selector === "[data-tablely-row]" ? rows : [],
    };
}

/* ------------------------------------------------------------------ *
 * ① 文案插值：`{{ name }}` 占位符（Liquid 只做 `| t | json`，替换在 JS）
 * ------------------------------------------------------------------ */

describe("makeT（locale 占位符替换）", () => {
    // 主题 locale 用的是 `{{ n }}`（带空格），M5 曾因 Liquid 侧做参数替换而 theme check 报错
    const dict = {
        added: "Added",
        lowStock: "Only {{ n }} left in stock",
        summary: "Selected {{ rows }} rows · {{ units }} units · Est. {{ total }}",
        noVars: "Out of stock",
    };

    it("替换 locale 原样的双花括号占位符（含多参数与空格）", () => {
        const t = runtime.makeT(dict);
        expect(t("lowStock", { n: 3 })).toBe("Only 3 left in stock");
        expect(t("summary", { rows: 2, units: 7, total: "$120.00" })).toBe(
            "Selected 2 rows · 7 units · Est. $120.00",
        );
    });

    it("无占位符 / 未传变量 / 未知 key 都安全", () => {
        const t = runtime.makeT(dict);
        expect(t("noVars")).toBe("Out of stock");
        expect(t("lowStock")).toBe("Only {{ n }} left in stock");
        expect(t("missing", { n: 1 })).toBe("");
    });

    it("未提供的变量保持原样（不产生 undefined）", () => {
        const t = runtime.makeT(dict);
        expect(t("lowStock", { other: 1 })).toBe("Only {{ n }} left in stock");
    });

    it("兼容单花括号 `{n}`（旧约定，避免旧文案静默失效）", () => {
        const t = runtime.makeT({ legacy: "Max {n}" });
        expect(t("legacy", { n: 9 })).toBe("Max 9");
    });
});

/* ------------------------------------------------------------------ *
 * ② 金额格式化：与主题 `| money` 同口径（§16.6）
 * ------------------------------------------------------------------ */

describe("formatMoney（与主题 money_format 同口径）", () => {
    it("覆盖 Shopify 官方四种 amount 占位符", () => {
        expect(runtime.formatMoney(123456, "${{amount}}")).toBe("$1,234.56");
        expect(runtime.formatMoney(123456, "{{amount_no_decimals}} kr")).toBe("1,235 kr");
        expect(runtime.formatMoney(123456, "€{{amount_with_comma_separator}}")).toBe(
            "€1.234,56",
        );
        expect(
            runtime.formatMoney(123456, "{{amount_no_decimals_with_comma_separator}} CHF"),
        ).toBe("1.235 CHF");
    });

    it("千分位与零值、负数（退款场景）都正确", () => {
        expect(runtime.formatMoney(0, "${{amount}}")).toBe("$0.00");
        expect(runtime.formatMoney(999, "${{amount}}")).toBe("$9.99");
        expect(runtime.formatMoney(100000000, "${{amount}}")).toBe("$1,000,000.00");
        // 减号由 `(cents/100).toFixed()` 自带，符号位置跟随格式串（与 `| money` 一致）
        expect(runtime.formatMoney(-1550, "${{amount}}")).toBe("$-15.50");
        expect(runtime.formatMoney(-1550, "{{amount}} €")).toBe("-15.50 €");
    });

    it("格式串缺失 / 非法时退回默认 `${{amount}}`，绝不抛错", () => {
        expect(runtime.formatMoney(1000)).toBe("$10.00");
        expect(runtime.formatMoney(1000, "")).toBe("$10.00");
        expect(runtime.formatMoney(1000, "no placeholder")).toBe("no placeholder");
    });
});

describe("toCents（阈值字符串 → 分）", () => {
    it("十进制字符串原样换算，空值 = 不限（null）", () => {
        expect(runtime.toCents("1000.00")).toBe(100000);
        expect(runtime.toCents("0.01")).toBe(1);
        expect(runtime.toCents("")).toBeNull();
        expect(runtime.toCents("   ")).toBeNull();
        expect(runtime.toCents(null)).toBeNull();
        expect(runtime.toCents(undefined)).toBeNull();
    });

    it("非数字拒绝（宁可不拦，也不因脏值把顾客拦死在门外）", () => {
        expect(runtime.toCents("abc")).toBeNull();
    });

    it("多于两位小数按分四舍五入（契约存的是两位，这里只做防御）", () => {
        expect(runtime.toCents("12.3456")).toBe(1235);
        expect(runtime.toCents("0.005")).toBe(1);
    });
});

/* ------------------------------------------------------------------ *
 * ③ 行级校验（§五 反馈规则第 5 条 / 第 4 条）
 * ------------------------------------------------------------------ */

describe("rowError（提交前拦截，含失败原因）", () => {
    it("数量为 0 / 空 / 负数 → 不参与本次加购，也不算失败", () => {
        for (const qty of ["0", "", "-3", "abc"]) {
            expect(runtime.rowError(fakeRow({ "data-min": "1" }, qty))).toBeNull();
        }
    });

    it("低于起订量 → belowMin（带 n）", () => {
        expect(runtime.rowError(fakeRow({ "data-min": "6" }, "3"))).toEqual({
            key: "belowMin",
            vars: { n: 6 },
        });
    });

    it("非步长倍数 → wrongStep", () => {
        expect(
            runtime.rowError(fakeRow({ "data-min": "1", "data-step": "6" }, "7")),
        ).toEqual({ key: "wrongStep", vars: { n: 6 } });
        expect(
            runtime.rowError(fakeRow({ "data-min": "1", "data-step": "6" }, "12")),
        ).toBeNull();
    });

    it("超库存优先于超上限（更可行动的原因）", () => {
        const row = fakeRow(
            { "data-min": "1", "data-step": "1", "data-max": "100", "data-stock": "4" },
            "5",
        );
        expect(runtime.rowError(row)).toEqual({ key: "lowStock", vars: { n: 4 } });
    });

    it("无库存追踪（没有 data-stock）时只看上限", () => {
        const row = fakeRow({ "data-min": "1", "data-max": "10" }, "11");
        expect(runtime.rowError(row)).toEqual({ key: "aboveMax", vars: { n: 10 } });
    });

    it("缺货行 → soldOut（即使数量格被清空也要给原因，不留空白气泡）", () => {
        expect(
            runtime.rowError(fakeRow({ "data-soldout": "true", "data-min": "1" }, "0")),
        ).toEqual({ key: "soldOut" });
    });

    it("合法值通过；`max` 为 null 时不误判", () => {
        expect(
            runtime.rowError(
                fakeRow(
                    { "data-min": "2", "data-step": "2", "data-max": "10", "data-stock": "10" },
                    "4",
                ),
            ),
        ).toBeNull();
        expect(
            runtime.rowError(fakeRow({ "data-min": "1", "data-step": "1" }, "99")),
        ).toBeNull();
    });
});

/* ------------------------------------------------------------------ *
 * ④ 步进器（§五 反馈规则第 1 条 / B14 键盘可达）
 * ------------------------------------------------------------------ */

describe("nextQuantity（− / + 步进）", () => {
    const bounds = (over: Partial<{ min: number; max: number | null; step: number }> = {}) => ({
        min: 1,
        max: null,
        step: 1,
        ...over,
    });

    it("从 0 往上先落到 min，再按 step 递增", () => {
        expect(runtime.nextQuantity(0, 1, bounds())).toBe(1);
        expect(runtime.nextQuantity(0, 1, bounds({ min: 6, step: 2 }))).toBe(6);
        expect(runtime.nextQuantity(6, 1, bounds({ min: 6, step: 2 }))).toBe(8);
    });

    it("往下低于 min 直接回 0（= 这一行不订购）", () => {
        expect(runtime.nextQuantity(1, -1, bounds())).toBe(0);
        expect(runtime.nextQuantity(6, -1, bounds({ min: 6, step: 2 }))).toBe(0);
        expect(runtime.nextQuantity(8, -1, bounds({ min: 6, step: 2 }))).toBe(6);
        expect(runtime.nextQuantity(0, -1, bounds())).toBe(0);
    });

    it("触顶保持原值（不产生越界值，也就不会出现「按 + 反而报错」）", () => {
        expect(runtime.nextQuantity(10, 1, bounds({ max: 10 }))).toBe(10);
        expect(runtime.nextQuantity(5, 1, bounds({ max: 4 }))).toBe(5);
    });

    it("非法 step / min 退回 1，绝不产生 0 或负值", () => {
        expect(runtime.nextQuantity(0, 1, { min: -1, max: null, step: 0 })).toBe(1);
        expect(runtime.nextQuantity(0, -1, { min: 1, max: null, step: 1 })).toBe(0);
    });
});

/* ------------------------------------------------------------------ *
 * ⑤ 合计与 Y14 闸门口径（§16.6：折前小计 = 显示单价 × 数量）
 * ------------------------------------------------------------------ */

describe("computeTotals（合计：行数 / 件数 / 折前小计）", () => {
    it("只统计数量 > 0 的行，金额 = Σ(data-price × 数量)", () => {
        const form = fakeForm(
            {},
            [
                fakeRow({ "data-price": "10000", "data-min": "1" }, "2"), // 2 × 100.00
                fakeRow({ "data-price": "2500", "data-min": "1" }, "1"), // 1 × 25.00
                fakeRow({ "data-price": "9999", "data-min": "1" }, "0"), // 未选，不计
            ],
        );
        expect(runtime.computeTotals(form)).toEqual({
            rows: 2,
            units: 3,
            cents: 22500,
        });
    });

    it("空表为全 0（不会因为 undefined 变成 NaN）", () => {
        expect(runtime.computeTotals(fakeForm({}, []))).toEqual({
            rows: 0,
            units: 0,
            cents: 0,
        });
    });

    it("缺 data-price 的行按 0 计（不产生 NaN 污染合计）", () => {
        const form = fakeForm({}, [fakeRow({ "data-min": "1" }, "3")]);
        expect(runtime.computeTotals(form).cents).toBe(0);
    });
});

/* ------------------------------------------------------------------ *
 * ⑥ 历史加购预填的合法化（M13 / Y15 / §15.7）
 * ------------------------------------------------------------------ */

describe("prefillQuantity（历史数量 → 合法数量）", () => {
    const bounds = (over: Partial<{ min: number; max: number | null; step: number }> = {}) => ({
        min: 1,
        max: null,
        step: 1,
        ...over,
    });

    it("无约束时原样取整（四舍五入）", () => {
        expect(runtime.prefillQuantity(12, bounds())).toBe(12);
        expect(runtime.prefillQuantity(12.4, bounds())).toBe(12);
        expect(runtime.prefillQuantity(12.5, bounds())).toBe(13);
    });

    it("非正数 / 非法一律 0（该行不填，绝不产生会导致提交失败的数值）", () => {
        expect(runtime.prefillQuantity(0, bounds())).toBe(0);
        expect(runtime.prefillQuantity(-5, bounds())).toBe(0);
        expect(runtime.prefillQuantity(NaN, bounds())).toBe(0);
        expect(runtime.prefillQuantity(Infinity, bounds())).toBe(0);
    });

    it("先吸附到 step（向上取整到倍数），再抬到 min", () => {
        expect(runtime.prefillQuantity(11, bounds({ step: 6 }))).toBe(12);
        expect(runtime.prefillQuantity(3, bounds({ min: 6, step: 2 }))).toBe(6);
        expect(runtime.prefillQuantity(9, bounds({ min: 6, step: 2 }))).toBe(10);
    });

    it("超上限时落到上限（上限低于 min 时仍保底 min，不产生非法值）", () => {
        expect(runtime.prefillQuantity(999, bounds({ max: 100 }))).toBe(100);
        expect(runtime.prefillQuantity(999, bounds({ min: 6, max: 4 }))).toBe(6);
    });

    it("step / min 非法时退回 1（不因脏数据算出 0 或负值）", () => {
        expect(runtime.prefillQuantity(5, { min: -3, max: null, step: 0 })).toBe(5);
        expect(runtime.prefillQuantity(0, { min: -3, max: null, step: 0 })).toBe(0);
    });
});

