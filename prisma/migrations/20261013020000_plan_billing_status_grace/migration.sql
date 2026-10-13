-- AlterTable: 记录 Shopify 订阅状态原文与计费周期末（应用内降级宽限，审核规则 1.2.3）
ALTER TABLE "PlanState" ADD COLUMN     "billingStatus" TEXT,
ADD COLUMN     "periodEndsAt" TIMESTAMPTZ(3);
