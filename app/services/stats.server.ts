/**
 * 加购统计（M14 / §1.4 #26 / §22.1）—— **服务端专用**
 *
 * 口径红线（继承 A3，不可放宽）：**纯加购指标** —— 行数 / 件数 / Top 变体 / 平均每单行数，
 * **不含转化率**（无曝光分母）、**不引入 Web Pixel**、**不读订单**（零 PCD）。
 *
 * 「一天」按**店铺时区**对齐（`ShopSettings` 无时区字段，时区来自 Admin API
 * `shop.ianaTimezone`，见 `getShopTimezone`），区间用 `tz.ts` 换算。
 *
 * ⚠️ 一次提交（`onSubmit`）的多行由店面 `tablely.js` **逐行上报**，库内**没有批次 id**；
 * `AddToCartEvent.rows` 存的是「本次提交行数」。因此「平均每单行数」的提交次数按
 * `(customerId, 提交所在秒, rows)` 归组估算 —— 同秒内同客户同行数的两次提交会被并成一次
 * （实际不可能发生，属可接受近似，§22.3 未强制提交定义）。
 */

import prisma from "../db.server";
import { logStructured } from "./monitor.server";
import { addDays, dayKeyOf, dayStartInTz, safeTimezone } from "./tz";
import type { GraphqlAdmin } from "./metafield.server";

/* ============================== 类型 ============================== */

export const STATS_WINDOWS = ["today", "7d", "30d"] as const;
export type StatsWindowKey = (typeof STATS_WINDOWS)[number];

export type StatsTotals = {
    /** 加购行数（= 事件条数） */
    rows: number;
    /** 件数（数量求和） */
    units: number;
    /** 提交次数（按上述归组口径估算） */
    submissions: number;
    /** 平均每单行数（保留 1 位小数；无提交时为 0） */
    avgRowsPerOrder: number;
};

export type StatsTopVariant = {
    variantId: string;
    units: number;
    /** 变体展示名（`商品 · 变体`）；解析失败为 `null`，由页面退回 `#<id>` */
    label: string | null;
};

export type AddToCartStats = {
    totals: Record<StatsWindowKey, StatsTotals>;
    /** 近 30 天 Top 变体（跨商品汇总，取前 N） */
    topVariants: StatsTopVariant[];
};

/** Top 变体条数上限（跨商品汇总后取前 N） */
export const TOP_VARIANTS_LIMIT = 5;

/** 各窗口回溯的日历天数（含今天）：今日 = 0、近 7 天 = 6、近 30 天 = 29 */
const WINDOW_DAYS_BACK: Record<StatsWindowKey, number> = {
    today: 0,
    "7d": 6,
    "30d": 29,
};

/* ============================== 区间 ============================== */

/** 某窗口在店铺时区下的 UTC 区间 `[start, end)`（`end` = 次日 00:00） */
export function windowRange(
    window: StatsWindowKey,
    timezone: string,
    now: Date = new Date(),
): { start: Date; end: Date } {
    const todayKey = dayKeyOf(now, timezone);
    return {
        start: dayStartInTz(addDays(todayKey, -WINDOW_DAYS_BACK[window]), timezone),
        end: dayStartInTz(addDays(todayKey, 1), timezone),
    };
}

/* ============================== 聚合 ============================== */

function emptyTotals(): StatsTotals {
    return { rows: 0, units: 0, submissions: 0, avgRowsPerOrder: 0 };
}

/** 一次提交的归组键（同一提交的逐行事件共享 customerId / 秒 / rows） */
function submissionKey(event: {
    customerId: string | null;
    rows: number;
    createdAt: Date;
}): string {
    const second = Math.floor(event.createdAt.getTime() / 1000);
    return `${event.customerId ?? "anon"}|${second}|${event.rows}`;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * 读取某店铺近 30 天的加购事件，切出今日 / 近 7 天 / 近 30 天三段汇总 + Top 变体。
 *
 * 单次查询（取最宽窗口 = 30 天）后在内存切片，避免三次往返。传 `admin` 时顺带解析
 * Top 变体展示名（Admin API 单次 `nodes` 查询，失败不影响数字）。
 */
export async function loadAddToCartStats(input: {
    shop: string;
    timezone: string;
    now?: Date;
    admin?: GraphqlAdmin;
}): Promise<AddToCartStats> {
    const now = input.now ?? new Date();
    const widest = windowRange("30d", input.timezone, now);

    const events = await prisma.addToCartEvent.findMany({
        where: {
            shop: input.shop,
            createdAt: { gte: widest.start, lt: widest.end },
        },
        orderBy: { createdAt: "asc" },
        select: {
            variantId: true,
            quantity: true,
            rows: true,
            customerId: true,
            createdAt: true,
        },
    });

    const totals: Record<StatsWindowKey, StatsTotals> = {
        today: emptyTotals(),
        "7d": emptyTotals(),
        "30d": emptyTotals(),
    };
    const submissions: Record<StatsWindowKey, Set<string>> = {
        today: new Set(),
        "7d": new Set(),
        "30d": new Set(),
    };
    const unitsByVariant = new Map<string, number>();

    const starts: Record<StatsWindowKey, number> = {
        today: windowRange("today", input.timezone, now).start.getTime(),
        "7d": windowRange("7d", input.timezone, now).start.getTime(),
        "30d": widest.start.getTime(),
    };

    for (const event of events) {
        const at = event.createdAt.getTime();
        const key = submissionKey(event);
        for (const window of STATS_WINDOWS) {
            if (at < starts[window]) continue;
            totals[window].rows += 1;
            totals[window].units += event.quantity;
            submissions[window].add(key);
        }
        unitsByVariant.set(
            event.variantId,
            (unitsByVariant.get(event.variantId) ?? 0) + event.quantity,
        );
    }

    for (const window of STATS_WINDOWS) {
        totals[window].submissions = submissions[window].size;
        totals[window].avgRowsPerOrder =
            submissions[window].size > 0
                ? round1(totals[window].rows / submissions[window].size)
                : 0;
    }

    const topVariants: StatsTopVariant[] = [...unitsByVariant.entries()]
        .map(([variantId, units]) => ({ variantId, units, label: null }))
        .sort((a, b) => b.units - a.units)
        .slice(0, TOP_VARIANTS_LIMIT);

    if (input.admin && topVariants.length > 0) {
        const labels = await resolveVariantLabels(
            input.admin,
            topVariants.map((item) => item.variantId),
        );
        for (const item of topVariants) {
            item.label = labels.get(item.variantId) ?? null;
        }
    }

    return { totals, topVariants };
}

/* ============================== Admin API ============================== */

const SHOP_TZ_QUERY = `#graphql
  query TablelyShopTimezone {
    shop {
      ianaTimezone
    }
  }
`;

/** 店铺 IANA 时区（取不到一律退回 `UTC`，统计不因 Admin API 抖动而中断） */
export async function getShopTimezone(admin: GraphqlAdmin): Promise<string> {
    try {
        const res = await admin.graphql(SHOP_TZ_QUERY);
        const json = (await res.json()) as {
            data?: { shop?: { ianaTimezone?: string | null } };
        };
        return safeTimezone(json.data?.shop?.ianaTimezone ?? "UTC");
    } catch (error) {
        logStructured("warn", "stats.shop_timezone_failed", {
            message: error instanceof Error ? error.message : String(error),
        });
        return "UTC";
    }
}

const VARIANT_LABELS_QUERY = `#graphql
  query TablelyVariantLabels($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        product {
          title
        }
      }
    }
  }
`;

type VariantNode = {
    id?: string;
    title?: string | null;
    sku?: string | null;
    product?: { title?: string | null } | null;
};

/** `商品 · 变体`（变体标题为 `Default Title` 时只留商品名；无商品名退回 SKU） */
export function formatVariantLabel(node: VariantNode): string | null {
    const productTitle = (node.product?.title ?? "").trim();
    const variantTitle = (node.title ?? "").trim();
    const sku = (node.sku ?? "").trim();
    if (productTitle) {
        if (!variantTitle || variantTitle.toLowerCase() === "default title") {
            return productTitle;
        }
        return `${productTitle} · ${variantTitle}`;
    }
    return variantTitle || sku || null;
}

/**
 * 解析 Top 变体的展示名（key = 纯数字变体 id，与 `AddToCartEvent.variantId` 同口径）。
 * 任何失败返回空 Map —— 页面退回 `#<id>`，不影响数字展示。
 */
export async function resolveVariantLabels(
    admin: GraphqlAdmin,
    variantIds: string[],
): Promise<Map<string, string>> {
    const ids = [...new Set(variantIds.filter((id) => /^\d+$/.test(id)))].slice(
        0,
        TOP_VARIANTS_LIMIT,
    );
    if (ids.length === 0) return new Map();
    try {
        const res = await admin.graphql(VARIANT_LABELS_QUERY, {
            variables: { ids: ids.map((id) => `gid://shopify/ProductVariant/${id}`) },
        });
        const json = (await res.json()) as { data?: { nodes?: (VariantNode | null)[] } };
        const map = new Map<string, string>();
        for (const node of json.data?.nodes ?? []) {
            if (!node?.id) continue;
            const label = formatVariantLabel(node);
            if (label) map.set(node.id.replace(/^.*\//, ""), label);
        }
        return map;
    } catch (error) {
        logStructured("warn", "stats.variant_labels_failed", {
            message: error instanceof Error ? error.message : String(error),
        });
        return new Map();
    }
}
