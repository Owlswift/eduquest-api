-- AlterTable
ALTER TABLE "Competition" ADD COLUMN     "advanceCount" INTEGER,
ADD COLUMN     "nextStageId" TEXT,
ADD COLUMN     "requiresQualification" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CompetitionQualification" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromCompetitionId" TEXT NOT NULL,
    "fromRank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitionQualification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompetitionQualification_userId_idx" ON "CompetitionQualification"("userId");

-- CreateIndex
CREATE INDEX "CompetitionQualification_fromCompetitionId_idx" ON "CompetitionQualification"("fromCompetitionId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionQualification_competitionId_userId_key" ON "CompetitionQualification"("competitionId", "userId");

-- CreateIndex
CREATE INDEX "Competition_nextStageId_idx" ON "Competition"("nextStageId");

-- AddForeignKey
ALTER TABLE "Competition" ADD CONSTRAINT "Competition_nextStageId_fkey" FOREIGN KEY ("nextStageId") REFERENCES "Competition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionQualification" ADD CONSTRAINT "CompetitionQualification_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionQualification" ADD CONSTRAINT "CompetitionQualification_fromCompetitionId_fkey" FOREIGN KEY ("fromCompetitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionQualification" ADD CONSTRAINT "CompetitionQualification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

