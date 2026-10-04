import { DiscountClass, ProductDiscountSelectionStrategy } from '../generated/api';
import { computeCandidates, gidToNumericId, parseJsonValue, toNumber } from './pricing';

/**
 * cart.lines.discounts.generate.run —— 三个 automatic discount（阶梯价 / 批发价 / Mix & Match）
 * 共用本 Function，靠 discount 节点上 `config` metafield 的 `mode` 字段区分行为。
 *
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 *
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const discount = input.discount;
  // 只对 Product 类折扣生效（三个 discount 均为 Product 类；Order 类无产品折扣可加）
  if (!discount?.discountClasses?.includes(DiscountClass.Product)) {
    return { operations: [] };
  }

  const config = parseJsonValue(discount.metafield?.value);
  const lines = normalizeLines(input.cart?.lines ?? []);
  if (!lines.length) return { operations: [] };

  const matchedTags = (input.cart?.buyerIdentity?.customer?.hasTags ?? [])
    .filter((entry) => entry?.hasTag)
    .map((entry) => entry.tag);

  const candidates = computeCandidates(config, lines, matchedTags);
  if (!candidates.length) return { operations: [] };

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          // 每个候选只瞄准各自的购物车行（targets 互不重叠），ALL 让每行各自生效
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}

/**
 * 购物车行 → 纯逻辑结构（抽出 vid / 单价 / 商品级 table metafield）
 * @param {import("../generated/api").CartInput['cart']['lines']} cartLines
 */
function normalizeLines(cartLines) {
  const lines = [];
  for (const line of cartLines) {
    const merchandise = line?.merchandise;
    // CustomProduct（礼卡等）没有 product 字段 → 不参与定价
    if (!merchandise || !merchandise.product) continue;
    const unitPrice = toNumber(line.cost?.amountPerQuantity?.amount) ?? 0;
    lines.push({
      id: String(line.id),
      quantity: Number(line.quantity) || 0,
      unitPrice,
      vid: gidToNumericId(merchandise.id),
      table: parseJsonValue(merchandise.product.metafield?.value),
    });
  }
  return lines;
}