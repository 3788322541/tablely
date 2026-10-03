/**
 * Shop 级设置与「安装自愈」（M4）
 *
 * 职责边界：
 *   · 本模块只管 **Shop 级** 配置（`ShopSettings` 表 → `tablely.settings` metafield）；
 *   · 商品级（Tables 页 / Drawer）走 `tables.server.ts`；
 *   · 序列化本身在 `metafield.server.ts`（唯一生成处），这里只做 DB 与 Admin API 编排。
 *
 * **顺序硬约束（§五 文件头）**：必须先 `ensureMetafieldDefinitions`（建定义、给店面可见性）
 * 再写值，否则先写的那次店面 Liquid 读不到（M0 实测）。
 *
 * 调用点：`afterAuth`（安装播种）+ Overview loader（每次进后台自愈兜底），
 * 两者都幂等：已存在的设置行**绝不覆盖**商家值，metafield 由 DB 现状重建（自愈陈旧值）。
 */

import prisma from "../db.server";
import {
    buildShopSettingsValue,
    ensureMetafieldDefinitions,
    getShopInfo,
    syncShopSettingsMetafield,
    toShopSettingsContract,
    type GraphqlAdmin,
    type ShopSettingsRowLike,
} from "./metafield.server";

/** 店铺级设置行（不存在返回 `null`，由调用方决定是否播种） */
export async function getShopSettingsRow(shop: string) {
    return prisma.shopSettings.findUnique({ where: { shop } });
}

/** 确保存在一行设置（已存在则**原样返回、不覆盖**；§六 安装播种约定） */
export async function ensureShopSettings(shop: string) {
    // 先读后建而不是 upsert：Overview 每次加载都会调用本函数，
    // 稳态下不该产生任何写（`upsert` 的 `update: {}` 仍可能打出一条 UPDATE）。
    const existing = await prisma.shopSettings.findUnique({ where: { shop } });
    if (existing) return existing;
    return prisma.shopSettings.create({ data: { shop } });
}

/**
 * 由 DB 现状重建并下发 Shop 级 `tablely.settings`。
 *
 * 用 DB 而非「本次表单」作数据源，是为了让 Overview 的兜底自愈也能修好陈旧 metafield。
 */
export async function pushShopSettingsMetafield(input: {
    admin: GraphqlAdmin;
    shop: string;
}): Promise<{ shopId: string; currencyCode: string }> {
    const row = await ensureShopSettings(input.shop);
    const info = await getShopInfo(input.admin);
    await syncShopSettingsMetafield(
        input.admin,
        info.id,
        buildShopSettingsValue(toShopSettingsContract(row as ShopSettingsRowLike)),
    );
    return { shopId: info.id, currencyCode: info.currencyCode };
}

/**
 * 安装 / 首次进后台的一站式自愈：**建定义 → 播种设置行 → 下发值**。
 *
 * 幂等且可重复调用（Overview 每次加载都跑）；任一步失败由调用方捕获，
 * 不阻塞认证与页面渲染。
 */
export async function ensureTablelySetup(input: {
    admin: GraphqlAdmin;
    shop: string;
}): Promise<{ createdDefinitions: string[]; shopId: string; currencyCode: string }> {
    const { created } = await ensureMetafieldDefinitions(input.admin);
    const info = await pushShopSettingsMetafield(input);
    return {
        createdDefinitions: created,
        shopId: info.shopId,
        currencyCode: info.currencyCode,
    };
}