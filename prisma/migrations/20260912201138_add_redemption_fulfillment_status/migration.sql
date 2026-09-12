-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'FULFILLED', 'REJECTED');

-- AlterTable
ALTER TABLE "RewardRedemption" ADD COLUMN     "fulfilledAt" TIMESTAMP(3),
ADD COLUMN     "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "RewardRedemption_status_idx" ON "RewardRedemption"("status");
