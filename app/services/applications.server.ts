/**
 * 分销商申请读写（M11 / §15.1 / §15.2）
 *
 * 职责边界（**关键取舍，重申 §2.4 / §15.2**）：
 *   · 申请只写**应用自己的 DB**（`WholesaleApplication`）；
 *   · 审批**绝不自动写客户 tag** —— 写 tag 需 `write_customers`，属受保护客户数据，
 *     与「零 PCD」冲突。改为引导商家在 Shopify 客户页手动打一次标签（`tablely-wholesale`），
 *     门控随后长期生效而无需任何客户写权限。
 *
 * 分档（§1.6 D2）：**提交与只读列表属 Free**；**审批 / 拒绝 / 备注属 Pro**（`approvals`），
 * 后端与前端共用 `hasFeature` 单点判定（§19.3），Free 越权调用在此抛 `error.proRequired`。
 *
 * 硬约束：`shop` 一律由调用方传入（Admin 取自 session，App Proxy 取自签名参数，§8.2 A），
 * 本模块不自行解析请求；按 id 的读写一律附带 `shop` 条件（越权防护）。
 */

import type { Prisma } from "@prisma/client";

import prisma from "../db.server";
import { hasFeature } from "../plan";
import { coercePayload, type ApplicationPayload } from "../applications";
import { resolvePlan, TablelyError } from "./tables.server";

/** 审批通过后引导商家手动添加的客户标签（§15.2 关键取舍） */
export const DEFAULT_WHOLESALE_TAG = "tablely-wholesale";

/** 被拒申请的保留期：90 天后自动删除（§8.1 唯一权威表） */
export const REJECTED_RETENTION_DAYS = 90;

/** 商家备注长度上限 */
const NOTE_MAX = 500;

export type ApplicationStatus = "pending" | "approved" | "rejected";

/** 状态白名单归一化（脏值一律退回 pending，不把未知状态写进 DB） */
export function normalizeApplicationStatus(value: unknown): ApplicationStatus {
    return value === "approved" || value === "rejected" ? value : "pending";
}

export type ApplicationRecord = {
    id: string;
    email: string;
    customerId: string | null;
    status: ApplicationStatus;
    note: string | null;
    createdAt: Date;
    payload: ApplicationPayload;
};

type ApplicationRow = {
    id: string;
    email: string;
    customerId: string | null;
    status: string;
    note: string | null;
    createdAt: Date;
    payload: unknown;
};

function toRecord(row: ApplicationRow): ApplicationRecord {
    return {
        id: row.id,
        email: row.email,
        customerId: row.customerId,
        status: normalizeApplicationStatus(row.status),
        note: row.note,
        createdAt: row.createdAt,
        payload: coercePayload(row.payload),
    };
}

/** 状态排序权重：待审批置顶，其余按提交时间倒序（列表首屏就是待办） */
const STATUS_WEIGHT: Record<ApplicationStatus, number> = {
    pending: 0,
    approved: 1,
    rejected: 2,
};

function normalizeNote(raw: unknown): string | null {
    const note = typeof raw === "string" ? raw.trim() : "";
    if (!note) return null;
    return note.length > NOTE_MAX ? note.slice(0, NOTE_MAX) : note;
}

/* ============================== 顾客提交 ============================== */

/**
 * 落库一条申请（Free 可用）。
 *
 * 去重口径（§15.1 #5）：**同店同邮箱只允许一条 `pending`** —— 重复提交直接拒绝，
 * 既防灌库也避免商家看到同一人的多条待办。已通过 / 已拒绝的历史行不阻挡再次申请。
 */
export async function createWholesaleApplication(input: {
    shop: string;
    payload: ApplicationPayload;
    customerId?: string | null;
}): Promise<{ id: string }> {
    const email = input.payload.email;

    const existing = await prisma.wholesaleApplication.findFirst({
        where: { shop: input.shop, email, status: "pending" },
        select: { id: true },
    });
    if (existing) throw new TablelyError("error.applicationDuplicate", "email");

    const created = await prisma.wholesaleApplication.create({
        data: {
            shop: input.shop,
            email,
            customerId: input.customerId ?? null,
            payload: input.payload as unknown as Prisma.InputJsonValue,
            status: "pending",
        },
        select: { id: true },
    });
    return { id: created.id };
}

/* ============================== 商家读取 ============================== */

/** 申请列表（待审批置顶；Free 只读同一份数据） */
export async function listWholesaleApplications(
    shop: string,
): Promise<ApplicationRecord[]> {
    const rows = await prisma.wholesaleApplication.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
    });
    return rows
        .map(toRecord)
        .sort((a, b) => {
            const weight = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
            if (weight !== 0) return weight;
            return b.createdAt.getTime() - a.createdAt.getTime();
        });
}

/** 待审批条数（导航角标 / Overview 入口，§15.2 Y4 应用内通知） */
export async function countPendingApplications(shop: string): Promise<number> {
    return prisma.wholesaleApplication.count({
        where: { shop, status: "pending" },
    });
}

/* ============================== 商家审批（Pro） ============================== */

/** 审批动作统一的前置校验：Pro + 行属于本店（不存在 / 跨店一律按不存在处理） */
async function requireOwnedRow(input: { shop: string; id: string }): Promise<void> {
    const plan = await resolvePlan(input.shop);
    if (!hasFeature(plan, "approvals")) throw new TablelyError("error.proRequired");

    const row = await prisma.wholesaleApplication.findFirst({
        where: { id: input.id, shop: input.shop },
        select: { id: true },
    });
    if (!row) throw new TablelyError("error.notFound");
}

/**
 * 通过申请：只改应用自己的状态为 `approved`。
 *
 * **不写客户 tag**（§15.2）：前端随后弹出「复制标签 `tablely-wholesale`」+「打开该客户页」，
 * 由商家手动在 Shopify 客户资料里打标签，门控据此长期生效。
 */
export async function approveWholesaleApplication(input: {
    shop: string;
    id: string;
}): Promise<{ tag: string }> {
    await requireOwnedRow(input);
    await prisma.wholesaleApplication.updateMany({
        where: { id: input.id, shop: input.shop },
        data: { status: "approved" },
    });
    return { tag: DEFAULT_WHOLESALE_TAG };
}

/** 拒绝申请：状态 `rejected` + 可选原因（保留 90 天后由 §8.1 清理） */
export async function rejectWholesaleApplication(input: {
    shop: string;
    id: string;
    note?: unknown;
}): Promise<void> {
    await requireOwnedRow(input);
    await prisma.wholesaleApplication.updateMany({
        where: { id: input.id, shop: input.shop },
        data: { status: "rejected", note: normalizeNote(input.note) },
    });
}

/** 保存商家备注（不改状态；用于「已通过 / 待跟进」等内部记录） */
export async function saveWholesaleApplicationNote(input: {
    shop: string;
    id: string;
    note?: unknown;
}): Promise<void> {
    await requireOwnedRow(input);
    await prisma.wholesaleApplication.updateMany({
        where: { id: input.id, shop: input.shop },
        data: { note: normalizeNote(input.note) },
    });
}

/* ============================== 保留期清理 ============================== */

/**
 * 删除本店超过保留期的**被拒**申请（§8.1：被拒 90 天）。
 *
 * 口径说明（如实记录）：§8.1 建议「定时任务」，本轮**不做独立调度器**
 * （不引入 `setInterval` / cron 依赖），改为在商家打开 Wholesale 页时**就近清理本店**，
 * 单次 `deleteMany` 命中 `(shop, status)` 索引，开销可忽略；已通过的行随商店存续，
 * 由 `shop/redact` / `app/uninstalled` 全量清除（`uninstall.server.ts`）。
 */
export async function purgeExpiredRejectedApplications(
    shop: string,
    now: Date = new Date(),
): Promise<number> {
    const cutoff = new Date(
        now.getTime() - REJECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const result = await prisma.wholesaleApplication.deleteMany({
        where: { shop, status: "rejected", createdAt: { lt: cutoff } },
    });
    return result.count;
}

/* ============================== 合规删除（§8.1） ============================== */

/**
 * `customers/redact`：删除该顾客在本店的申请行（按 `email` 或 `customerId` 命中，幂等）。
 * 两个标识都缺时不动任何数据（避免误删整店）。
 */
export async function redactApplicationsByCustomer(input: {
    shop: string;
    email?: string | null;
    customerId?: string | null;
}): Promise<number> {
    const email = (input.email ?? "").trim().toLowerCase();
    const customerId = (input.customerId ?? "").trim();

    const matches: Prisma.WholesaleApplicationWhereInput[] = [];
    if (email) matches.push({ email });
    if (customerId) matches.push({ customerId });
    if (matches.length === 0) return 0;

    const result = await prisma.wholesaleApplication.deleteMany({
        where: { shop: input.shop, OR: matches },
    });
    return result.count;
}

/** `customers/data_request`：该顾客在本店的申请摘要（Level 0，仅 B2B 联络字段，§8.1） */
export async function summarizeApplicationsForCustomer(input: {
    shop: string;
    email?: string | null;
    customerId?: string | null;
}): Promise<ApplicationRecord[]> {
    const email = (input.email ?? "").trim().toLowerCase();
    const customerId = (input.customerId ?? "").trim();

    const matches: Prisma.WholesaleApplicationWhereInput[] = [];
    if (email) matches.push({ email });
    if (customerId) matches.push({ customerId });
    if (matches.length === 0) return [];

    const rows = await prisma.wholesaleApplication.findMany({
        where: { shop: input.shop, OR: matches },
        orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
}