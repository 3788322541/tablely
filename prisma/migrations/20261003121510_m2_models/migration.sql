-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultLayout" TEXT NOT NULL DEFAULT 'table',
    "taxDisplay" TEXT NOT NULL DEFAULT 'incl',
    "outOfStockMode" TEXT NOT NULL DEFAULT 'gray',
    "gateMode" TEXT NOT NULL DEFAULT 'off',
    "gateTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "theme" JSONB NOT NULL DEFAULT '{}',
    "feedbackStyle" TEXT NOT NULL DEFAULT 'inline',
    "hideNative" BOOLEAN NOT NULL DEFAULT false,
    "nativeSelector" TEXT,
    "blockAddedAt" TIMESTAMPTZ(3),
    "firstProductAt" TIMESTAMPTZ(3),
    "firstAddToCart" TIMESTAMPTZ(3),
    "orderMinAmount" DECIMAL(10,2),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTable" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "layout" TEXT,
    "columns" JSONB NOT NULL DEFAULT '{}',
    "defaultTiers" JSONB NOT NULL DEFAULT '[]',
    "orderMinAmount" DECIMAL(10,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProductTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "min" INTEGER NOT NULL DEFAULT 1,
    "max" INTEGER,
    "step" INTEGER NOT NULL DEFAULT 1,
    "tiers" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "VariantRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerGroup" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomerGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayoutTemplate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LayoutTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "title" TEXT,
    "note" TEXT,
    "currency" TEXT NOT NULL,
    "validUntil" TIMESTAMPTZ(3) NOT NULL,
    "customerId" TEXT,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MixMatchGroup" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tiers" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MixMatchGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MixMatchMember" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "MixMatchMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesalePrice" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "groupTag" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WholesalePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WholesaleApplication" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "customerId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WholesaleApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AddToCartEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "rows" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL DEFAULT 'table',
    "customerId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddToCartEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "trialEndsAt" TIMESTAMPTZ(3),
    "syncedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PlanState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountState" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "tierDiscountId" TEXT,
    "wholeDiscountId" TEXT,
    "mixMatchDiscountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DiscountState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTable_shop_productId_key" ON "ProductTable"("shop", "productId");

-- CreateIndex
CREATE INDEX "VariantRule_shop_productId_idx" ON "VariantRule"("shop", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantRule_shop_variantId_key" ON "VariantRule"("shop", "variantId");

-- CreateIndex
CREATE INDEX "CustomerGroup_shop_idx" ON "CustomerGroup"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerGroup_shop_tag_key" ON "CustomerGroup"("shop", "tag");

-- CreateIndex
CREATE INDEX "LayoutTemplate_shop_idx" ON "LayoutTemplate"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "LayoutTemplate_shop_name_key" ON "LayoutTemplate"("shop", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_token_key" ON "Quote"("token");

-- CreateIndex
CREATE INDEX "Quote_shop_createdAt_idx" ON "Quote"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "MixMatchGroup_shop_idx" ON "MixMatchGroup"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "MixMatchGroup_shop_name_key" ON "MixMatchGroup"("shop", "name");

-- CreateIndex
CREATE INDEX "MixMatchMember_shop_variantId_idx" ON "MixMatchMember"("shop", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "MixMatchMember_shop_groupId_variantId_key" ON "MixMatchMember"("shop", "groupId", "variantId");

-- CreateIndex
CREATE INDEX "WholesalePrice_shop_groupTag_idx" ON "WholesalePrice"("shop", "groupTag");

-- CreateIndex
CREATE UNIQUE INDEX "WholesalePrice_shop_variantId_groupTag_key" ON "WholesalePrice"("shop", "variantId", "groupTag");

-- CreateIndex
CREATE INDEX "WholesaleApplication_shop_status_idx" ON "WholesaleApplication"("shop", "status");

-- CreateIndex
CREATE INDEX "AddToCartEvent_shop_createdAt_idx" ON "AddToCartEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AddToCartEvent_shop_customerId_createdAt_idx" ON "AddToCartEvent"("shop", "customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanState_shop_key" ON "PlanState"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "DiscountState_shop_key" ON "DiscountState"("shop");
