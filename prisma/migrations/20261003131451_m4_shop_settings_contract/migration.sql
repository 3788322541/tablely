-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "columns" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "tierEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tierModel" TEXT NOT NULL DEFAULT 'percent';
