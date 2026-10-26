-- CreateEnum
CREATE TYPE "PrizeAwardStatus" AS ENUM ('AWAITING_CLAIM', 'CLAIMED', 'VERIFIED', 'FULFILLED', 'FORFEITED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CertificateKind" AS ENUM ('SUBJECT', 'PARTICIPATION', 'WINNER');

-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN     "competitionId" TEXT,
ADD COLUMN     "kind" "CertificateKind" NOT NULL DEFAULT 'SUBJECT',
ADD COLUMN     "rank" INTEGER,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "verificationCode" TEXT,
ALTER COLUMN "subjectId" DROP NOT NULL;

-- Existing (subject) certificates get a public verification code too.
UPDATE "Certificate"
   SET "verificationCode" = 'EQ-' || upper(substr(md5("id" || random()::text), 1, 5)) || '-' || upper(substr(md5(random()::text || "id"), 1, 5))
 WHERE "verificationCode" IS NULL;
ALTER TABLE "Certificate" ALTER COLUMN "verificationCode" SET NOT NULL;

-- CreateTable
CREATE TABLE "PrizeAward" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "prizeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "status" "PrizeAwardStatus" NOT NULL DEFAULT 'AWAITING_CLAIM',
    "claimDeadline" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimDetails" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilmentNote" TEXT,
    "closedReason" TEXT,
    "promotedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrizeAward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrizeAward_userId_idx" ON "PrizeAward"("userId");

-- CreateIndex
CREATE INDEX "PrizeAward_competitionId_status_idx" ON "PrizeAward"("competitionId", "status");

-- CreateIndex
CREATE INDEX "PrizeAward_status_claimDeadline_idx" ON "PrizeAward"("status", "claimDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "PrizeAward_competitionId_userId_key" ON "PrizeAward"("competitionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_verificationCode_key" ON "Certificate"("verificationCode");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_userId_competitionId_kind_key" ON "Certificate"("userId", "competitionId", "kind");

-- AddForeignKey
ALTER TABLE "PrizeAward" ADD CONSTRAINT "PrizeAward_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizeAward" ADD CONSTRAINT "PrizeAward_prizeId_fkey" FOREIGN KEY ("prizeId") REFERENCES "CompetitionPrize"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizeAward" ADD CONSTRAINT "PrizeAward_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

