/**
 * M12 定价配置一致性单测（§21.1 单元层 / §21.2）
 *
 * 覆盖两件事：
 *   ① `buildPricingConfigs`（app 侧写入 discount function metafield 的 config）形态正确；
 *   ② **app 侧配置 × 扩展 Function 的纯逻辑** 端到端自洽 —— 用 `buildPricingConfigs` 产出的
 *      config，喂给 `extensions/tablely-pricing/src/pricing.js` 的 `computeCandidates`，
 *      断言折扣值符合 §16.2 / §16.4 / §16.5 的优先级口径。
 *
 * 为什么能直接 import 扩展的 `.js`：`pricing.js` 是**无依赖的纯逻辑**（不 import `generated/api`），
 * 正是为了这种跨层对照而刻意与 wasm 入口隔离的。
 */

import { describe, expect, test } from "vitest";

import { buildPricingConfigs } from "./discounts.server";
import { normalizeTiers } from "./metafield.server";
// 扩展源码是 JS（无独立 .d.ts），由 tsconfig allowJs 推断类型；此处跨包引用属刻意为之
import { computeCandidates } from "../../extensions/tablely-pricing/src/pricing.js";

type BuiltConfig = { slot: string; mode: string; title: string; value: string };

function configValue(configs: BuiltConfig[], mode: string): Record<string, unknown> {
    const found = configs.find((config) => config.mode === mode);
    if (!found) throw new Error(`缺少 mode=${mode} 的 config`);
    return JSON.parse(found.value) as Record<string, unknown>;
}

/** 构造一条购物车行（归一化后的形态，与 extension run 入口一致） */
function line(overrides: {
    vid: string;
    quantity: number;
    unitPrice: number;
    tiers?: unknown[];
    wholesale?: unknown[];
}) {
    return {
        id: `gid://shopify/CartLine/${overrides.vid}`,
        quantity: overrides.quantity,
        unitPrice: overrides.unitPrice,
        vid: overrides.vid,
        table: {
            rows: [
                {
                    vid: overrides.vid,
                    tiers: overrides.tiers ?? [],
                    wholesale: overrides.wholesale ?? [],
                },
            ],
        },
    };
}

describe("buildPricingConfigs", () => {
    test("三份 config 的 mode 与开关正确，且共享同一组 groupTags", () => {
        const { configs, variablesValue } = buildPricingConfigs({
            tierEnabled: false,
            groupTags: ["  tier1 ", "tier1", "", "vip"],
            mixGroups: [],
        });

        expect(configs.map((config) => config.slot)).toEqual([
            "tierDiscountId",
            "wholeDiscountId",
            "mixMatchDiscountId",
        ]);

        const tier = configValue(configs, "tier");
        const wholesale = configValue(configs, "wholesale");
        const mixmatch = configValue(configs, "mixmatch");

        // 阶梯价开关跟随 ShopSettings.tierEnabled；另两个恒为启用（是否生效由数据决定）
        expect(tier.enabled).toBe(false);
        expect(wholesale.enabled).toBe(true);
        expect(mixmatch.enabled).toBe(true);
        // 标签 trim + 去重去空
        expect(tier.groupTags).toEqual(["tier1", "vip"]);
        expect(variablesValue).toBe(JSON.stringify({ customerTags: ["tier1", "vip"] }));
    });

    test("只有阶梯价与混单携带 mixGroups；批发价的 mixGroups 为空", () => {
        const { configs } = buildPricingConfigs({
            tierEnabled: true,
            groupTags: [],
            mixGroups: [
                { id: "g1", tiers: [{ qty: 5, percent: 10 }], vids: ["111", "222"] },
            ],
        });

        expect(configValue(configs, "tier").mixGroups).toEqual([
            { key: "g1", tiers: [{ qty: 5, percent: 10 }], vids: ["111", "222"] },
        ]);
        expect(configValue(configs, "mixmatch").mixGroups).toHaveLength(1);
        expect(configValue(configs, "wholesale").mixGroups).toEqual([]);
    });

    test("无成员或无档位的混单组被丢弃（不写进 Function 配置）", () => {
        const { configs } = buildPricingConfigs({
            tierEnabled: true,
            groupTags: [],
            mixGroups: [
                { id: "empty", tiers: [{ qty: 5, percent: 10 }], vids: [] },
                { id: "no-tier", tiers: [], vids: ["111"] },
                { id: "ok", tiers: [{ qty: 3, price: "9.00" }], vids: ["333"] },
            ],
        });

        expect(configValue(configs, "mixmatch").mixGroups).toEqual([
            { key: "ok", tiers: [{ qty: 3, price: "9.00" }], vids: ["333"] },
        ]);
    });
});

describe("app 配置 × Function 纯逻辑（一致性）", () => {
    // 纯阶梯 / 批发：不带混单组，便于单独验证 §16.2 / §16.4
    const plain = buildPricingConfigs({
        tierEnabled: true,
        groupTags: ["vip"],
        mixGroups: [],
    });
    const tierConfig = configValue(plain.configs, "tier");
    const wholesaleConfig = configValue(plain.configs, "wholesale");

    // 含混单组：验证 §16.5 的「混单优先于阶梯价」
    const mixed = buildPricingConfigs({
        tierEnabled: true,
        groupTags: ["vip"],
        mixGroups: [
            { id: "g1", tiers: [{ qty: 5, percent: 15 }], vids: ["111", "222"] },
        ],
    });
    const tierConfigWithMix = configValue(mixed.configs, "tier");
    const mixConfig = configValue(mixed.configs, "mixmatch");

    test("阶梯价：模型 A 按该变体数量命中最高档（百分比）", () => {
        const out = computeCandidates(
            tierConfig,
            [line({ vid: "111", quantity: 12, unitPrice: 100, tiers: [{ qty: 5, percent: 10 }, { qty: 10, percent: 20 }] })],
            [],
        );
        expect(out).toEqual([
            {
                message: "Tablely tier price",
                targets: [{ cartLine: { id: "gid://shopify/CartLine/111" } }],
                value: { percentage: { value: 20 } },
            },
        ]);
    });

    test("批发客不享阶梯价（§16.4 优先级）", () => {
        const out = computeCandidates(
            tierConfig,
            [line({ vid: "111", quantity: 12, unitPrice: 100, tiers: [{ qty: 5, percent: 20 }] })],
            ["vip"],
        );
        expect(out).toEqual([]);
    });

    test("批发价：命中组标签 → 模型 B 固定金额逼近目标单价", () => {
        const out = computeCandidates(
            wholesaleConfig,
            [line({ vid: "111", quantity: 5, unitPrice: 100, wholesale: [{ group: "vip", price: "80.00" }] })],
            ["vip"],
        );
        expect(out).toEqual([
            {
                message: "Tablely wholesale price",
                targets: [{ cartLine: { id: "gid://shopify/CartLine/111" } }],
                value: { fixedAmount: { amount: 100, appliesToEachItem: false } },
            },
        ]);
    });

    test("混单：组内合计达量 → 每行按各自数量享同一档（§16.5）", () => {
        const out = computeCandidates(
            mixConfig,
            [
                line({ vid: "111", quantity: 3, unitPrice: 100, tiers: [{ qty: 10, percent: 5 }] }),
                line({ vid: "222", quantity: 2, unitPrice: 50, tiers: [] }),
            ],
            [],
        );
        // 组内合计 5 件命中 15% 档：两行各按自身金额享 15%
        expect(out).toEqual([
            {
                message: "Tablely mix & match",
                targets: [{ cartLine: { id: "gid://shopify/CartLine/111" } }],
                value: { percentage: { value: 15 } },
            },
            {
                message: "Tablely mix & match",
                targets: [{ cartLine: { id: "gid://shopify/CartLine/222" } }],
                value: { percentage: { value: 15 } },
            },
        ]);
    });

    test("混单命中时阶梯价跳过该行（混单优先，二者不叠加）", () => {
        const out = computeCandidates(
            tierConfigWithMix,
            [
                line({ vid: "111", quantity: 3, unitPrice: 100, tiers: [{ qty: 2, percent: 30 }] }),
                line({ vid: "222", quantity: 2, unitPrice: 50, tiers: [{ qty: 2, percent: 30 }] }),
            ],
            [],
        );
        // 组内合计 5 命中混单档，故阶梯价 30% 被跳过 → 阶梯价输出为空
        expect(out).toEqual([]);
    });
});

describe("normalizeTiers", () => {
    test("归一化模型 A / B，丢弃脏档位并按原顺序保留", () => {
        expect(
            normalizeTiers([
                { qty: "5", percent: 10 },
                { qty: 3.9, price: " 12.00 " },
                { qty: 0, percent: 5 },
                { qty: 2 },
                null,
            ]),
        ).toEqual([
            { qty: 5, percent: 10 },
            { qty: 3, price: "12.00" },
        ]);
    });
});