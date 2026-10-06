import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { logStructured } from "../services/monitor.server";

/**
 * App Block 渲染检测上报（M14 / Y1 激活漏斗）—— **公开、无鉴权、跨域**
 *
 * 谁在调：店面 `tablely.js` 的增强层初始化时（只在 App Block 真的渲染出来的商品页，
 * 因为配置与脚本由 `table-runtime.liquid` 在「确认渲染」时才引入）。
 *
 * 与 `api.addtocart.tsx` 同一套路：**任何失败一律返 204**，绝不因为一次统计失败
 * 而干扰店面渲染或报错弹窗。载体用 `text/plain` 承载 JSON（避免 CORS 预检，
 * 也让 `navigator.sendBeacon` 可用）。
 *
 * 归属校验（§8.2 A）：`shop` 必须已存在于本应用的 `ShopSettings`，否则静默丢弃。
 * 首次写入后不再覆盖：`updateMany({ where: { shop, blockAddedAt: null } })`。
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
        return empty(204);
    }

    const shop = String((payload as Record<string, unknown> | null)?.shop ?? "").trim();
    if (!shop) return empty(204);

    try {
        // 只对本应用服务过的店铺记账（未登记的域名静默丢弃，不当成错误）
        const settings = await prisma.shopSettings.findUnique({
            where: { shop },
            select: { id: true, blockAddedAt: true },
        });
        if (settings && !settings.blockAddedAt) {
            await prisma.shopSettings.updateMany({
                where: { shop, blockAddedAt: null },
                data: { blockAddedAt: new Date() },
            });
        }
    } catch (error) {
        logStructured("warn", "api.track.failed", {
            shop,
            message: error instanceof Error ? error.message : String(error),
        });
    }

    return empty(204);
};

export const loader = () => empty(405);
