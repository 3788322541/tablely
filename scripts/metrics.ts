/**
 * §22 指标出数脚本（npm run metrics）
 *
 * 方案 §22.3 的硬约束：**不新增表、不做后台指标页**，出数靠「一段只读脚本 + Partner Dashboard」。
 * 本脚本即那段脚本：
 *   · **只读**：全部是 `findMany({ select })`，不写任何一张表，也不建表 / 不改 schema；
 *   · 口径全部来自 `app/services/metrics.server.ts` 的纯函数（被 `metrics.test.ts` 钉住），
 *     本文件只负责取数 + 排版；
 *   · 默认输出 Markdown，`--csv` 输出 CSV，`--weeks=N` 调整分周窗口（默认 12 周，§22.1 第 12 周目标）。
 *
 * 不支持项（明确写出来，避免把「脚本算不出」误当「指标为 0」）：
 *   · 卸载率 / MRR / Pro 占比 / 评分评论数 → 只在 Partner Dashboard；
 *   · 降级后 30 天恢复率 → 需要 Billing 事件历史，DB 只有快照，这里给两个代理值。
 *
 * 用法：
 *   npm run metrics                 # Markdown
 *   npm run metrics -- --csv        # CSV
 *   npm run metrics -- --weeks=4    # 只看最近 4 周
 */
import { PrismaClient } from "@prisma/client";

import {
    activationFunnel,
    applicationStats,
    averageQuantityPerSubmission,
    averageRowsPerSubmission,
    blockAddedWithoutAddToCart,
    medianWeeklySubmissionsPerShop,
    monetizationSnapshot,
    retentionAtDays,
    weeklyActiveShops,
} from "../app/services/metrics.server";

// 本地直跑时读 .env；CI / 容器里环境变量已注入，这里失败可忽略
try {
    process.loadEnvFile(".env");
} catch {
    /* 无 .env 文件时沿用现有环境变量 */
}

const args = process.argv.slice(2);
const asCsv = args.includes("--csv");
const weeksArg = args.find((arg) => arg.startsWith("--weeks="));
const weeks = weeksArg ? Number.parseInt(weeksArg.slice("--weeks=".length), 10) : 12;

if (!Number.isFinite(weeks) || weeks <= 0) {
    console.error("metrics 失败：--weeks 必须是正整数");
    process.exit(1);
}

const prisma = new PrismaClient();

/** 一行输出（Markdown 表格行 / CSV 行） */
interface Row {
    section: string;
    metric: string;
    value: string;
}

const format = (value: number | null, unit = ""): string => {
    if (value === null) return "n/a";
    return `${value}${unit}`;
};

async function main(): Promise<void> {
    const now = new Date();

    // —— 只读取数（§22.3 复用既有数据，不新增表）——
    const [shops, events, plans, applications] = await Promise.all([
        prisma.shopSettings.findMany({
            select: {
                shop: true,
                createdAt: true,
                blockAddedAt: true,
                firstProductAt: true,
                firstAddToCart: true,
            },
        }),
        // 加购事件按 §8.1 只保留 180 天，故全量读取即天然有界
        prisma.addToCartEvent.findMany({
            select: { shop: true, rows: true, quantity: true, createdAt: true },
        }),
        prisma.planState.findMany({
            select: {
                shop: true,
                plan: true,
                trialEndsAt: true,
                everPro: true,
                winbackSeenAt: true,
            },
        }),
        prisma.wholesaleApplication.findMany({ select: { shop: true, status: true } }),
    ]);

    const funnel = activationFunnel(shops);
    const was = weeklyActiveShops(events, { weeks, now });
    const latestWas = was.at(-1)?.activeShops ?? 0;
    const rows4w = retentionAtDays(shops, events, { days: 28, now });
    const rows90d = retentionAtDays(shops, events, { days: 90, now });
    const money = monetizationSnapshot(plans);
    const apps = applicationStats(applications);

    const rows: Row[] = [
        { section: "激活", metric: "安装店铺数", value: String(funnel.installed) },
        {
            section: "激活",
            metric: "App Block 已添加",
            value: `${funnel.blockAdded} (${format(funnel.blockAddedRate, "%")})`,
        },
        {
            section: "激活",
            metric: "首个订购表启用",
            value: `${funnel.firstProduct} (${format(funnel.firstProductRate, "%")})`,
        },
        {
            section: "激活",
            metric: "首次加购成功",
            value: `${funnel.firstAddToCart} (${format(funnel.firstAddToCartRate, "%")})`,
        },
        {
            section: "激活",
            metric: "中位激活时长",
            value: format(funnel.medianHoursToFirstAddToCart, " h"),
        },
        {
            section: "使用",
            metric: `WAS（第 ${was.length} 周，即最近一周）`,
            value: `${latestWas} (${format(
                latestWas && funnel.installed
                    ? Math.round((latestWas / funnel.installed) * 1000) / 10
                    : null,
                "%",
            )} 安装占比)`,
        },
        {
            section: "使用",
            metric: "每店周提交数（中位，剔除单次试玩）",
            value: format(medianWeeklySubmissionsPerShop(events, { weeks, now })),
        },
        {
            section: "使用",
            metric: "平均每单行数",
            value: format(averageRowsPerSubmission(events)),
        },
        {
            section: "使用",
            metric: "平均每单件数",
            value: format(averageQuantityPerSubmission(events)),
        },
        {
            section: "留存",
            metric: "4 周留存",
            value: `${rows4w.retained}/${rows4w.cohort} (${format(rows4w.rate, "%")})`,
        },
        {
            section: "留存",
            metric: "90 天留存",
            value: `${rows90d.retained}/${rows90d.cohort} (${format(rows90d.rate, "%")})`,
        },
        {
            section: "变现",
            metric: "进入试用 / 曾为 Pro",
            value: String(money.trialStarted),
        },
        { section: "变现", metric: "当前 Pro（ACTIVE）", value: String(money.activePro) },
        {
            section: "变现",
            metric: "试用 → 付费转化",
            value: format(money.trialToPaidRate, "%"),
        },
        {
            section: "变现",
            metric: "当前处于降级（反指标①）",
            value: String(money.downgradedNow),
        },
        {
            section: "变现",
            metric: "win-back 代理值（看卡后回到 Pro）",
            value: String(money.winbackReturned),
        },
        {
            section: "反指标",
            metric: "已加 Block 但从未加购（④）",
            value: String(blockAddedWithoutAddToCart(shops)),
        },
        { section: "申请", metric: "申请总数", value: String(apps.total) },
        { section: "申请", metric: "待处理", value: String(apps.pending) },
        { section: "申请", metric: "已通过", value: String(apps.approved) },
        { section: "申请", metric: "已拒绝", value: String(apps.rejected) },
        {
            section: "申请",
            metric: "通过率（分母＝已裁决）",
            value: format(apps.approvalRate, "%"),
        },
    ];

    const generatedAt = now.toISOString();

    if (asCsv) {
        console.log("section,metric,value");
        for (const row of rows) {
            console.log(`"${row.section}","${row.metric}","${row.value}"`);
        }
    } else {
        console.log(`# Tablely 指标（§22）`);
        console.log("");
        console.log(`- 生成时间：${generatedAt}（分周按 UTC 周一）`);
        console.log(`- 分周窗口：最近 ${weeks} 周`);
        console.log(`- 数据源：只读 ShopSettings / AddToCartEvent / PlanState / WholesaleApplication`);
        console.log("");
        console.log("| 层 | 指标 | 值 |");
        console.log("|---|---|---|");
        for (const row of rows) {
            console.log(`| ${row.section} | ${row.metric} | ${row.value} |`);
        }
        console.log("");
        console.log("## WAS 趋势");
        console.log("");
        console.log("| 周起始 | 活跃店铺 |");
        console.log("|---|---|");
        for (const week of was) {
            console.log(`| ${week.weekStart} | ${week.activeShops} |`);
        }
        console.log("");
        console.log(
            "> 脚本无法出数的：卸载率 / MRR / Pro 占比 / 评分评论数（Partner Dashboard）、降级后 30 天恢复率（无 Billing 事件历史，见 §22.1 注）。",
        );
    }
}

main()
    .catch((error) => {
        console.error("metrics 失败：", error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
