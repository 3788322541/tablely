import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { logStructured } from "../services/monitor.server";

/**
 * 加购上报（M13 / §十五 A3）—— **公开、无鉴权、跨域**，照抄 Linkly `api.click.tsx` 范式
 *
 * 谁在调：店面 `tablely.js`（商品页）与快速补货页的内联脚本。上报是 fire-and-forget：
 * **任何失败一律返 204**，绝不因为一次统计失败而阻塞或干扰加购（§十二 验收 26）。
 *
 * 请求体用 `text/plain` 承载 JSON 文本，不用 `application/json` ——
 * 后者会触发 CORS 预检；`navigator.sendBeacon` 也只能发安全列表类型。
 * JS 侧优先 `sendBeacon`，失败再退 `fetch(keepalive)`。
 *
 * 归属校验（§8.2 A）：`shop` 必须**已存在于本应用的 `ShopSettings`**（即本应用服务过的店），
 * 否则静默丢弃 —— 绝不为任意传入域名落库。`shop` 是店铺 myshopify 域
 * （Liquid `shop.permanent_domain`），与 `session.shop` 同口径。
 *
 * Y1 激活漏斗（§12.4）：首次成功上报时写入 `ShopSettings.firstAddToCart`，
 * 用 `updateMany ... firstAddToCart: null` 保证**首次写入后不再覆盖**（§十二 验收 26）。
 */

/** `customerId` 在店面是纯数字串；`variantId` 同理（契约里 `rows[].vid` 也是纯数字） */
const DIGITS_RE = /^\d+$/;
const SOURCES = new Set(["table", "reorder", "csv"]);

/**
 * 上报从**店铺域名**跨域发起：`Access-Control-Allow-Origin: *` 供 `fetch(keepalive)`
 * 兜底路径读响应；`sendBeacon` 走 `text/plain` 属安全列表类型，本身不触发预检。
 */
const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
};

const empty = (status: number) => new Response(null, { status, headers: CORS_HEADERS });

export const action = async ({ request }: ActionFunctionArgs) => {
    if (request.method === "OPTIONS") return empty(204);
    if (request.method !== "POST") return empty(405);

    let payload: unknown = null;
    try {
        payload = JSON.parse(await request.text());
    } catch {
        return empty(400);
    }

    const body = (payload ?? {}) as Record<string, unknown>;
    const shop = String(body.shop ?? "").trim();
    const productId = String(body.productId ?? "").trim();
    const variantId = String(body.variantId ?? "").trim();
    const customerId = String(body.customerId ?? "").trim();
    const quantity = Math.floor(Number(body.quantity));
    const rows = Math.floor(Number(body.rows));

    if (!shop || !DIGITS_RE.test(variantId)) return empty(400);
    if (!Number.isFinite(quantity) || quantity < 1) return empty(400);
    if (!Number.isFinite(rows) || rows < 1) return empty(400);

    const rawSource = String(body.source ?? "table");
    const source = SOURCES.has(rawSource) ? rawSource : "table";

    try {
        // 归属校验：只有本应用已建设置的店才记账（其余静默丢弃，不当成错误）
        const settings = await prisma.shopSettings.findUnique({
            where: { shop },
            select: { id: true, firstAddToCart: true },
        });
        if (!settings) return empty(204);

        await prisma.addToCartEvent.create({
            data: {
                shop,
                productId,
                variantId,
                quantity,
                rows,
                source,
                // 未登录顾客无法把记录归属到客户 → 存 null（A4：不进历史列表）
                customerId: DIGITS_RE.test(customerId) ? customerId : null,
            },
        });

        // Y1：首次加购时间戳，只写一次（条件更新，不覆盖已写入的值）
        if (!settings.firstAddToCart) {
            await prisma.shopSettings.updateMany({
                where: { shop, firstAddToCart: null },
                data: { firstAddToCart: new Date() },
            });
        }
    } catch (error) {
        logStructured("warn", "api.addtocart.failed", {
            shop,
            variantId,
            message: error instanceof Error ? error.message : String(error),
        });
    }

    return empty(204);
};

export const loader = () => empty(405);