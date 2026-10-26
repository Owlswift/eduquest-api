-- AlterEnum
ALTER TYPE "AttemptSource" ADD VALUE 'COMPETITION';

-- CreateEnum
CREATE TYPE "Region" AS ENUM ('NORTH_CENTRAL', 'NORTH_EAST', 'NORTH_WEST', 'SOUTH_EAST', 'SOUTH_SOUTH', 'SOUTH_WEST');

-- CreateEnum
CREATE TYPE "CompetitionType" AS ENUM ('MINI', 'MONTHLY', 'STATE', 'REGIONAL', 'NATIONAL');

-- CreateEnum
CREATE TYPE "CompetitionFormat" AS ENUM ('XP_WINDOW', 'FIXED_SET');

-- CreateEnum
CREATE TYPE "CompetitionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ACTIVE', 'CLOSED', 'FINALISED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('ENTERED', 'IN_PROGRESS', 'COMPLETED', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "PrizeKind" AS ENUM ('COINS', 'AIRTIME', 'DATA', 'DEVICE', 'SCHOLARSHIP', 'BOOKS', 'CERTIFICATE', 'OTHER');

-- AlterTable
ALTER TABLE "Competition" ADD COLUMN     "claimDeadlineDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "classLevels" "ClassLevel"[],
ADD COLUMN     "description" TEXT,
ADD COLUMN     "finalisedAt" TIMESTAMP(3),
ADD COLUMN     "format" "CompetitionFormat" NOT NULL DEFAULT 'XP_WINDOW',
ADD COLUMN     "participationCoins" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "participationXp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "penaltyPerWrong" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsPerCorrect" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "questionCount" INTEGER,
ADD COLUMN     "questionIds" TEXT[],
ADD COLUMN     "region" "Region",
ADD COLUMN     "state" TEXT,
ADD COLUMN     "status" "CompetitionStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN     "subjectIds" TEXT[],
ADD COLUMN     "timeLimitSec" INTEGER,
ADD COLUMN     "type" "CompetitionType" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "CompetitionParticipant" ADD COLUMN     "answerHash" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "correctCount" INTEGER,
ADD COLUMN     "disqualifiedReason" TEXT,
ADD COLUMN     "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rank" INTEGER,
ADD COLUMN     "score" INTEGER,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" "EntryStatus" NOT NULL DEFAULT 'ENTERED',
ADD COLUMN     "timeTakenSec" INTEGER,
ADD COLUMN     "wrongCount" INTEGER;

-- AlterTable
ALTER TABLE "QuizSession" ADD COLUMN     "competitionId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CompetitionPrize" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "positionFrom" INTEGER NOT NULL,
    "positionTo" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "PrizeKind" NOT NULL DEFAULT 'OTHER',
    "coinAmount" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CompetitionPrize_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompetitionPrize_competitionId_idx" ON "CompetitionPrize"("competitionId");

-- CreateIndex
CREATE INDEX "Competition_status_idx" ON "Competition"("status");

-- CreateIndex
CREATE INDEX "CompetitionParticipant_competitionId_status_score_idx" ON "CompetitionParticipant"("competitionId", "status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "QuizSession_userId_competitionId_key" ON "QuizSession"("userId", "competitionId");

-- AddForeignKey
ALTER TABLE "QuizSession" ADD CONSTRAINT "QuizSession_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionPrize" ADD CONSTRAINT "CompetitionPrize_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: Postgres leaves newly added array columns NULL on existing rows.
UPDATE "Competition" SET "classLevels" = '{}' WHERE "classLevels" IS NULL;
UPDATE "Competition" SET "subjectIds" = '{}' WHERE "subjectIds" IS NULL;
UPDATE "Competition" SET "questionIds" = '{}' WHERE "questionIds" IS NULL;

-- Backfill: competitions that already ended are archived; the rest are
-- published and advance to ACTIVE / CLOSED with the clock. They keep the
-- original XP_WINDOW format, so nothing changes for students mid-contest.
UPDATE "Competition" SET "status" = 'ARCHIVED' WHERE "endsAt" < NOW();
UPDATE "Competition" SET "publishedAt" = "createdAt" WHERE "publishedAt" IS NULL;
