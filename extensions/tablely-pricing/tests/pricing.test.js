import { describe, test, expect } from "vitest";
import { computeCandidates, gidToNumericId, parseJsonValue, round2 } from "../src/pricing.js";

const line = (overrides) => ({
  id: "gid://shopify/CartLine/0",
  quantity: 1,
  unitPrice: 20,
  vid: "111",
  table: null,
  ...overrides,
});

const table = (rows) => ({ rows });

describe("pricing 纯逻辑", () => {
  test("gidToNumericId 取 GID 末段", () => {
    expect(gidToNumericId("gid://shopify/ProductVariant/123")).toBe("123");
    expect(gidToNumericId("123")).toBe("123");
    expect(gidToNumericId("")).toBe("");
  });

  test("parseJsonValue 容错", () => {
    expect(parseJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonValue("{bad")).toBeNull();
    expect(parseJsonValue(null)).toBeNull();
    expect(parseJsonValue({ a: 1 })).toEqual({ a: 1 });
  });

  test("round2 保留两位小数", () => {
    expect(round2(22.949999)).toBe(22.95);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  test("tier：同一变体多行数量累加后匹配最高档", () => {
    const config = { mode: "tier", enabled: true, groupTags: [], mixGroups: [] };
    const shared = table([{ vid: "111", tiers: [{ qty: 5, percent: 12 }], wholesale: [] }]);
    const lines = [
      line({ id: "L0", quantity: 3, table: shared }),
      line({ id: "L1", quantity: 3, table: shared }),
    ];
    // 合计 6 ≥ 5 → 两行各自按 12% 输出
    const candidates = computeCandidates(config, lines, []);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].value).toEqual({ percentage: { value: 12 } });
  });

  test("tier：未达最低档不输出", () => {
    const config = { mode: "tier", enabled: true, groupTags: [], mixGroups: [] };
    const lines = [
      line({
        quantity: 2,
        table: table([{ vid: "111", tiers: [{ qty: 5, percent: 12 }], wholesale: [] }]),
      }),
    ];
    expect(computeCandidates(config, lines, [])).toEqual([]);
  });

  test("tier：固定价档按行数量分摊且四舍五入到分", () => {
    const config = { mode: "tier", enabled: true, groupTags: [], mixGroups: [] };
    const lines = [
      line({
        quantity: 3,
        unitPrice: 19.99,
        table: table([{ vid: "111", tiers: [{ qty: 3, price: "12.34" }], wholesale: [] }]),
      }),
    ];
    const candidates = computeCandidates(config, lines, []);
    expect(candidates[0].value).toEqual({
      fixedAmount: { amount: 22.95, appliesToEachItem: false },
    });
  });

  test("wholesale：多标签命中取最低价", () => {
    const config = { mode: "wholesale", enabled: true, groupTags: ["tier1", "tier2"], mixGroups: [] };
    const lines = [
      line({
        quantity: 2,
        unitPrice: 100,
        table: table([
          {
            vid: "111",
            tiers: [],
            wholesale: [
              { group: "tier1", price: "95.00" },
              { group: "tier2", price: "88.00" },
            ],
          },
        ]),
      }),
    ];
    const candidates = computeCandidates(config, lines, ["tier2", "tier1"]);
    expect(candidates[0].value).toEqual({
      fixedAmount: { amount: 24, appliesToEachItem: false },
    });
  });

  test("wholesale：无命中标签不输出", () => {
    const config = { mode: "wholesale", enabled: true, groupTags: ["tier2"], mixGroups: [] };
    const lines = [
      line({
        quantity: 2,
        table: table([{ vid: "111", tiers: [], wholesale: [{ group: "tier2", price: "88.00" }] }]),
      }),
    ];
    expect(computeCandidates(config, lines, [])).toEqual([]);
  });

  test("mixmatch：组内合计达量后每行各自输出", () => {
    const config = {
      mode: "mixmatch",
      enabled: true,
      groupTags: [],
      mixGroups: [{ key: "g1", tiers: [{ qty: 5, percent: 15 }], vids: ["111", "222"] }],
    };
    const lines = [
      line({ id: "L0", vid: "111", quantity: 3, unitPrice: 20 }),
      line({ id: "L1", vid: "222", quantity: 4, unitPrice: 30 }),
    ];
    const candidates = computeCandidates(config, lines, []);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.targets[0].cartLine.id)).toEqual(["L0", "L1"]);
  });

  test("mixmatch：批发客户跳过", () => {
    const config = {
      mode: "mixmatch",
      enabled: true,
      groupTags: ["tier1"],
      mixGroups: [{ key: "g1", tiers: [{ qty: 5, percent: 15 }], vids: ["111"] }],
    };
    const lines = [line({ quantity: 6 })];
    expect(computeCandidates(config, lines, ["tier1"])).toEqual([]);
  });

  test("enabled=false / 未知 mode / 空购物车 一律不输出", () => {
    const lines = [line({ quantity: 6 })];
    expect(computeCandidates({ mode: "tier", enabled: false }, lines, [])).toEqual([]);
    expect(computeCandidates({ mode: "nope", enabled: true }, lines, [])).toEqual([]);
    expect(computeCandidates({ mode: "tier", enabled: true }, [], [])).toEqual([]);
    expect(computeCandidates(null, lines, [])).toEqual([]);
  });
});