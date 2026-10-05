import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { getT, localeFromRequest } from "../i18n";
import { hasFeature } from "../plan";
import {
    CSV_TEMPLATE_ROW,
    toErrorCsv,
    toImportCsv,
    type CsvDataRow,
} from "../services/csv.server";
import { takeCsvErrors } from "../services/csvImport.server";
import { normalizeTiers, type GraphqlAdmin } from "../services/metafield.server";
import { logStructured } from "../services/monitor.server";
import { gidToNumericId, resolvePlan } from "../services/tables.server";
import { authenticate } from "../shopify.server";

/**
 * CSV 生成器唯一出口（Y16 / §15.6）—— **资源路由**（无 default export，不渲染布局）
 *
 * 三种模式（`?mode=`）：
 *   · `template`：下载模板 —— 无任何规则时输出「列头 + 1 行示例」，有数据时等价于导出；
 *   · `export`  ：导出当前店铺实际规则（`min/max/step` + 档位 + 商品级起订金额）；
 *   · `errors`  ：下载上一次导入的**完整错误清单**（`?token=`，由 `csvImport.server.ts` 暂存）。
 *
 * 硬约束（§15.5 / §15.6）：
 *   · `toImportCsv` / `toErrorCsv` 是**唯一**的 CSV 生产者，列头取同一常量 `CSV_COLUMNS`，
 *     本文件**不手写任何列头**；
 *   · RFC4180 转义 + UTF-8 BOM 由生成器保证；**文件在服务端生成**（便于鉴权）；
 *   · CSV（含 `sku`）属商家数据，**不写入日志**（§8.2 D）；
 *   · 属 Pro 功能，后端同样以 `hasFeature(plan, "csv")` 拒写（§19.3）。
 *
 * `authenticate.admin` 在**新标签页**打开（`window.open`）时按非嵌入文档请求解析会话；
 * 未过 Pro 门控返回 403 纯文本，不泄露任何数据。
 */

const FORBIDDEN = () =>
    new Response("Forbidden", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });

/** 文件名安全的店铺标识：myshopify 域名里的 `.` 换成 `-` */
function shopSlug(shop: string): string {
    return shop.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
}

function todayStamp(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/** 文件下载响应：attachment + 不缓存 */
function csvResponse(csv: string, filename: string): Response {
    return new Response(csv, {
        headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "cache-control": "no-store",
        },
    });
}

/* ---------------------------- 导出数据组装 ---------------------------- */

const VARIANTS_BY_IDS_QUERY = `#graphql
  query TablelyExportVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        sku
        title
        product {
          id
          title
        }
      }
    }
  }
`;

type ExportVariantRef = { sku: string; title: string; productTitle: string };

/** 按 id 批量取变体（SKU / 标题 / 商品标题），分块避免单次 query 过长 */
async function fetchVariantRefs(
    admin: GraphqlAdmin,
    ids: string[],
): Promise<Map<string, ExportVariantRef>> {
    const map = new Map<string, ExportVariantRef>();
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const res = await admin.graphql(VARIANTS_BY_IDS_QUERY, {
            variables: { ids: ids.slice(i, i + CHUNK) },
        });
        const json = await res.json();
        const nodes = (json as {
            data?: {
                nodes?: ({
                    id?: string;
                    sku?: string | null;
                    title?: string | null;
                    product?: { title?: string | null } | null;
                } | null)[];
            };
        })?.data?.nodes ?? [];
        for (const node of nodes) {
            if (!node?.id) continue;
            map.set(node.id, {
                sku: node.sku ?? "",
                title: node.title ?? "",
                productTitle: node.product?.title ?? "",
            });
        }
    }
    return map;
}

/**
 * 最小合法数量：`ceil(min/step)*step`，再受 `max` 约束（§15.6）。
 * 导出这一「可被原样重新导入」的数量，构成「导出 → 改 → 导入」闭环（验收 33）。
 */
function minimalQuantity(min: number, max: number | null, step: number): number {
    const safeStep = step > 1 ? step : 1;
    let qty = Math.max(min, Math.ceil(min / safeStep) * safeStep);
    if (max !== null) qty = Math.max(min, Math.min(qty, max));
    return qty;
}

/** 当前店铺全部变体规则 → 导出/模板共用的行（只含数量与价格规则，§15.5） */
async function buildExportRows(
    admin: GraphqlAdmin,
    shop: string,
): Promise<CsvDataRow[]> {
    const [rules, tables] = await Promise.all([
        prisma.variantRule.findMany({ where: { shop } }),
        prisma.productTable.findMany({ where: { shop } }),
    ]);
    if (rules.length === 0) return [];

    const orderMinByProduct = new Map(
        tables.map((table) => [
            table.productId,
            table.orderMinAmount ? table.orderMinAmount.toFixed(2) : "",
        ]),
    );

    const refs = await fetchVariantRefs(
        admin,
        rules.map((rule) => rule.variantId),
    );

    const sorted = [...rules].sort((a, b) =>
        a.productId === b.productId
            ? a.variantId.localeCompare(b.variantId)
            : a.productId.localeCompare(b.productId),
    );

    return sorted.map((rule) => {
        const ref = refs.get(rule.variantId);
        const tiers = normalizeTiers(rule.tiers);
        const percents = tiers.map((tier) =>
            tier.percent !== undefined ? String(tier.percent) : "",
        );
        const prices = tiers.map((tier) => tier.price ?? "");
        const usePercent = tiers.length > 0 && tiers.every((tier) => tier.percent !== undefined);
        return {
            sku: ref?.sku ?? "",
            variant_id: gidToNumericId(rule.variantId),
            product_title: ref?.productTitle ?? "",
            variant_title: ref?.title ?? "",
            quantity: String(minimalQuantity(rule.min, rule.max, rule.step)),
            min_qty: String(rule.min),
            max_qty: rule.max === null ? "" : String(rule.max),
            step_qty: String(rule.step),
            order_min_amount: orderMinByProduct.get(rule.productId) ?? "",
            tier_qty: tiers.map((tier) => String(tier.qty)).join("|"),
            tier_price: usePercent ? "" : prices.join("|"),
            tier_percent: usePercent ? percents.join("|") : "",
        } satisfies CsvDataRow;
    });
}

/* ============================== loader ============================== */

export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "template";

    // 后端门控（§19.3）：前端禁用只是提示，服务端必须拒
    const plan = await resolvePlan(session.shop);
    if (!hasFeature(plan, "csv")) return FORBIDDEN();

    const locale = localeFromRequest(request);
    const t = getT(locale);
    const stamp = todayStamp();

    if (mode === "errors") {
        const token = url.searchParams.get("token") ?? "";
        const rows = token ? takeCsvErrors(session.shop, token) : null;
        if (!rows || rows.length === 0) {
            return new Response("Not Found", {
                status: 404,
                headers: {
                    "content-type": "text/plain; charset=utf-8",
                    "cache-control": "no-store",
                },
            });
        }
        // error 列存的是 i18n key，导出时按请求语言本地化（错误清单给商家看，用后台语言）
        const csv = toErrorCsv(rows.map((row) => ({ ...row, error: t(row.error) })));
        logStructured("info", "csv.error_list_exported", { shop: session.shop });
        return csvResponse(csv, `tablely-import-errors-${stamp}.csv`);
    }

    const rows = await buildExportRows(admin, session.shop);

    // 模板：无数据时用占位示例行；有数据时等价于导出（§15.6）
    const payload = mode === "template" && rows.length === 0 ? [CSV_TEMPLATE_ROW] : rows;
    const csv = toImportCsv(payload);
    logStructured("info", "csv.exported", {
        shop: session.shop,
        mode,
        rows: rows.length,
    });
    return csvResponse(csv, `tablely-export-${shopSlug(session.shop)}-${stamp}.csv`);
};