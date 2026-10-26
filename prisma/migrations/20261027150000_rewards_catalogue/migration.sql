-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RedemptionStatus" ADD VALUE 'APPROVED';
ALTER TYPE "RedemptionStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "RewardRedemption" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "note" TEXT;

-- CreateTable
CREATE TABLE "Reward" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "description" TEXT,
    "coinCost" INTEGER NOT NULL,
    "stock" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "kind" "PrizeKind" NOT NULL DEFAULT 'OTHER',
    "imageKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reward_active_sortOrder_idx" ON "Reward"("active", "sortOrder");


-- Seed: the six rewards that used to live in code. Stock is left unlimited so
-- nothing changes for students until an admin sets it; use the admin catalogue
-- to cap the laptop and scholarship before they can be redeemed in bulk.
INSERT INTO "Reward" ("id", "title", "subtitle", "coinCost", "kind", "imageKey", "sortOrder", "updatedAt") VALUES
  ('airtime_500',  'Airtime',      'N500',       500,   'AIRTIME',     'gold_coin', 1, NOW()),
  ('data_1gb',     'Data Bundle',  '1GB',        800,   'DATA',        NULL,        2, NOW()),
  ('edu_books',    'Edu Books',    'E-Book',     1200,  'BOOKS',       'girl_books', 3, NOW()),
  ('exam_voucher', 'Exam Voucher', 'WAEC',       1500,  'OTHER',       NULL,        4, NOW()),
  ('laptop',       'Laptop',       'HP 14"',     25000, 'DEVICE',      NULL,        5, NOW()),
  ('scholarship',  'Scholarship',  'University', 50000, 'SCHOLARSHIP', NULL,        6, NOW())
ON CONFLICT ("id") DO NOTHING;
