-- AlterTable
ALTER TABLE "PlanState" ADD COLUMN     "everPro" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "winbackSeenAt" TIMESTAMPTZ(3);
