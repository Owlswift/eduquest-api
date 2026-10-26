-- CreateEnum
CREATE TYPE "LedgerCurrency" AS ENUM ('XP', 'COIN');

-- CreateEnum
CREATE TYPE "QuizSessionStatus" AS ENUM ('OPEN', 'SUBMITTED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "starterChallengeCompletedAt" TIMESTAMP(3),
ADD COLUMN     "welcomeBonusClaimedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" "LedgerCurrency" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "questionIds" TEXT[],
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" "QuizSessionStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "QuizSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_currency_createdAt_idx" ON "LedgerEntry"("userId", "currency", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_reason_createdAt_idx" ON "LedgerEntry"("userId", "reason", "createdAt");

-- CreateIndex
CREATE INDEX "QuizSession_userId_status_idx" ON "QuizSession"("userId", "status");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSession" ADD CONSTRAINT "QuizSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: accounts that already received the one-time awards must not be
-- able to claim them again. The welcome bonus sets streak = 1 and adds
-- coins/XP; the starter challenge adds the First Steps badge.
UPDATE "User" SET "welcomeBonusClaimedAt" = NOW()
  WHERE "xp" > 0 OR "coins" > 0 OR "streak" > 0;
UPDATE "User" SET "starterChallengeCompletedAt" = NOW()
  WHERE "badges" > 0 OR "questionsAnswered" > 0;

-- Backfill: opening balances, so that the ledger sums to the current
-- User.xp / User.coins for every existing account.
INSERT INTO "LedgerEntry" ("id", "userId", "currency", "amount", "reason", "idempotencyKey")
SELECT 'open_xp_' || "id", "id", 'XP', "xp", 'opening_balance', 'opening:xp:' || "id"
  FROM "User" WHERE "xp" <> 0;
INSERT INTO "LedgerEntry" ("id", "userId", "currency", "amount", "reason", "idempotencyKey")
SELECT 'open_coin_' || "id", "id", 'COIN', "coins", 'opening_balance', 'opening:coin:' || "id"
  FROM "User" WHERE "coins" <> 0;
