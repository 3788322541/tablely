/**
 * Tablely 定价纯逻辑（M12 / §2.2）
 *
 * 与 `generated/api` 完全隔离：这里只吃「普通 JS 对象」，吐「product discount candidate 数组」，
 * 便于单测（vitest 直接 import 本文件，无需构建 wasm），也让三种 mode 的规则集中在一处。
 *
 * 三种 mode（由 discount 节点上 `config` metafield 的 `mode` 字段区分）：
 *   · tier      —— 阶梯价：按「该变体在购物车中的总数量」匹配最高档；
 *   · wholesale —— 批发价：按顾客命中的客户组标签匹配该变体的批发价，多标签命中取**最低价**；
 *   · mixmatch  —— Mix & Match：组内**合计数量**（跨行跨变体）匹配最高档，命中后组内每行各自分摊。
 *
 * 跨折扣优先级（三个 automatic discount 并发且互不可见）在本模块内部自判：
 *   · 批发客户（命中任一 `groupTags`）不享阶梯价与混单价；
 *   · 某行所属混单组已命中混单档时，阶梯价跳过该行（混单优先）。
 *
 * @typedef {Object} PricingCandidate
 * @property {string} message
 * @property {{cartLine: {id: string}}[]} targets
 * @property {{percentage: {value: number}} | {fixedAmount: {amount: number, appliesToEachItem: boolean}}} value
 *
 * @typedef {Object} PricingLine
 * @property {string} id 购物车行 ID（`gid://shopify/CartLine/...`）
 * @property {number} quantity 该行数量
 * @property {number} unitPrice 单价
 * @property {string} vid 纯数字变体 ID（由 GID 末段提取）
 * @property {Object|null} table 该变体所属商品的 `table` metafield 解析结果
 *
 * @typedef {Object} PricingConfig
 * @property {string} [mode]
 * @property {boolean} [enabled]
 * @property {string[]} [groupTags]
 * @property {{key: string, tiers: Object[], vids: (string|number)[]}[]} [mixGroups]
 */

export const PRICING_MODES = ["tier", "wholesale", "mixmatch"];

const MESSAGES = {
  tier: "Tablely tier price",
  wholesale: "Tablely wholesale price",
  mixmatch: "Tablely mix & match",
};

/* ============================== 工具 ============================== */

/**
 * `gid://shopify/ProductVariant/123` → `"123"`（已是纯数字则原样返回）
 * @param {string} gid
 * @returns {string}
 */
export function gidToNumericId(gid) {
  if (!gid) return "";
  const parts = String(gid).split("/");
  return parts[parts.length - 1];
}

/**
 * 安全解析 JSON（字符串 / 对象 / null）；失败返回 null
 * @param {unknown} value
 * @returns {object|null}
 */
export function parseJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 转数字（`undefined` / 非数字 → null）
 * @param {unknown} value
 * @returns {number|null}
 */
export function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const num = Number(text);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * 金额四舍五入到分（2 位小数），避免浮点误差进候选值
 * @param {number} value
 * @returns {number}
 */
export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 在某商品的 `rows[]` 里按纯数字 vid 找行
 * @param {Object|null} table
 * @param {string} vid
 * @returns {Object|null}
 */
function findRow(table, vid) {
  if (!table || !Array.isArray(table.rows)) return null;
  for (const row of table.rows) {
    if (row && String(row.vid) === String(vid)) return row;
  }
  return null;
}

/**
 * 匹配最高档：`quantity >= tier.qty` 中 `qty` 最大者
 * @param {unknown} tiers
 * @param {number} quantity
 * @returns {Object|null}
 */
function matchTier(tiers, quantity) {
  if (!Array.isArray(tiers)) return null;
  let best = null;
  let bestQty = -1;
  for (const tier of tiers) {
    if (!tier || typeof tier !== "object") continue;
    const qty = toNumber(tier.qty);
    if (qty === null || quantity < qty) continue;
    if (qty > bestQty) {
      bestQty = qty;
      best = tier;
    }
  }
  return best;
}

/**
 * 档位条目 → 候选值（percent 优先；price 走固定金额）+ 该行折扣金额（用于比较力度）
 * @param {Object} entry
 * @param {number} unitPrice
 * @param {number} quantity
 * @returns {{value: Object, amount: number}|null}
 */
function entryToValue(entry, unitPrice, quantity) {
  const percent = toNumber(entry.percent);
  if (percent !== null) {
    if (percent <= 0) return null;
    return {
      value: { percentage: { value: percent } },
      amount: round2((unitPrice * quantity * percent) / 100),
    };
  }
  const price = toNumber(entry.price);
  if (price === null) return null;
  const amount = round2((unitPrice - price) * quantity);
  if (amount <= 0) return null;
  return { value: { fixedAmount: { amount, appliesToEachItem: false } }, amount };
}

/**
 * 组装一个「整行」候选
 * @param {string} mode
 * @param {string} lineId
 * @param {Object} entry
 * @param {number} unitPrice
 * @param {number} quantity
 * @returns {Object|null}
 */
function buildCandidate(mode, lineId, entry, unitPrice, quantity) {
  const hit = entryToValue(entry, unitPrice, quantity);
  if (!hit) return null;
  return {
    message: MESSAGES[mode],
    targets: [{ cartLine: { id: lineId } }],
    value: hit.value,
  };
}

/**
 * 按 vid 汇总购物车各行的数量（同一变体多行累加）
 * @param {Array} lines
 * @returns {Map<string, number>}
 */
function totalQuantityByVid(lines) {
  const totals = new Map();
  for (const line of lines) {
    totals.set(line.vid, (totals.get(line.vid) ?? 0) + line.quantity);
  }
  return totals;
}

/**
 * 混单组命中：返回「已命中混单档」的 vid 集合（供阶梯价跳过）
 * @param {Object} config
 * @param {Map<string, number>} totals
 * @returns {Set<string>}
 */
function mixAppliedVids(config, totals) {
  const applied = new Set();
  const groups = Array.isArray(config.mixGroups) ? config.mixGroups : [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.vids)) continue;
    let groupQty = 0;
    for (const vid of group.vids) groupQty += totals.get(String(vid)) ?? 0;
    if (groupQty <= 0) continue;
    if (!matchTier(group.tiers, groupQty)) continue;
    for (const vid of group.vids) applied.add(String(vid));
  }
  return applied;
}

/* ============================ 三种 mode ============================ */

/**
 * 阶梯价：批发客户跳过；混单已命中的行跳过；否则按变体总数量匹配最高档
 * @returns {Object[]}
 */
function computeTier(config, lines, isWholesale) {
  if (isWholesale) return [];
  const totals = totalQuantityByVid(lines);
  const mixVids = mixAppliedVids(config, totals);
  const candidates = [];
  for (const line of lines) {
    if (mixVids.has(line.vid)) continue;
    const row = findRow(line.table, line.vid);
    if (!row) continue;
    const tier = matchTier(row.tiers, totals.get(line.vid) ?? line.quantity);
    if (!tier) continue;
    const candidate = buildCandidate("tier", line.id, tier, line.unitPrice, line.quantity);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/**
 * 批发价：按命中的客户组标签取该变体**最低**批发价
 * @returns {Object[]}
 */
function computeWholesale(lines, matchedTags) {
  const candidates = [];
  for (const line of lines) {
    const row = findRow(line.table, line.vid);
    if (!row || !Array.isArray(row.wholesale)) continue;
    let lowest = null;
    for (const entry of row.wholesale) {
      if (!entry || typeof entry !== "object") continue;
      const group = String(entry.group ?? "");
      if (!group || !matchedTags.has(group)) continue;
      const price = toNumber(entry.price);
      if (price === null) continue;
      if (lowest === null || price < lowest) lowest = price;
    }
    if (lowest === null) continue;
    const candidate = buildCandidate(
      "wholesale",
      line.id,
      { price: lowest },
      line.unitPrice,
      line.quantity,
    );
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/**
 * Mix & Match：批发客户跳过；组内合计数量匹配最高档；同一行属多组时取折扣金额最大者，且只应用一次
 * @returns {Object[]}
 */
function computeMixMatch(config, lines, isWholesale) {
  if (isWholesale) return [];
  const totals = totalQuantityByVid(lines);
  const groups = Array.isArray(config.mixGroups) ? config.mixGroups : [];

  const groupHits = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.vids)) continue;
    let groupQty = 0;
    for (const vid of group.vids) groupQty += totals.get(String(vid)) ?? 0;
    if (groupQty <= 0) continue;
    const tier = matchTier(group.tiers, groupQty);
    if (!tier) continue;
    groupHits.push({ vids: new Set(group.vids.map((vid) => String(vid))), tier });
  }
  if (groupHits.length === 0) return [];

  const candidates = [];
  for (const line of lines) {
    let bestAmount = -1;
    let bestCandidate = null;
    for (const hit of groupHits) {
      if (!hit.vids.has(line.vid)) continue;
      const scored = entryToValue(hit.tier, line.unitPrice, line.quantity);
      if (!scored) continue;
      if (scored.amount > bestAmount) {
        bestAmount = scored.amount;
        bestCandidate = {
          message: MESSAGES.mixmatch,
          targets: [{ cartLine: { id: line.id } }],
          value: scored.value,
        };
      }
    }
    if (bestCandidate) candidates.push(bestCandidate);
  }
  return candidates;
}

/* ============================== 入口 ============================== */

/**
 * 三 mode 统一入口。
 *
 * @param {Object|null} config discount `config` metafield 解析结果
 * @param {Array} lines 购物车行（已归一化）
 * @param {string[]} matchedTags 顾客命中的标签（`hasTags` 返回 `hasTag=true` 的 tag）
 * @returns {Object[]}
 */
export function computeCandidates(config, lines, matchedTags) {
  if (!config || config.enabled === false) return [];
  if (!lines.length) return [];
  const mode = config.mode;
  if (!PRICING_MODES.includes(mode)) return [];

  const groupTags = new Set(
    (Array.isArray(config.groupTags) ? config.groupTags : []).map((tag) => String(tag)),
  );
  const tagSet = new Set(matchedTags.map((tag) => String(tag)));
  const isWholesale = [...tagSet].some((tag) => groupTags.has(tag));

  switch (mode) {
    case "tier":
      return computeTier(config, lines, isWholesale);
    case "wholesale":
      return computeWholesale(lines, tagSet);
    case "mixmatch":
      return computeMixMatch(config, lines, isWholesale);
    default:
      return [];
  }
}