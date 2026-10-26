-- AlterEnum
ALTER TYPE "CompetitionFormat" ADD VALUE 'POINTS_LEAGUE';

-- AlterTable
ALTER TABLE "Competition" ADD COLUMN     "dailyPointsCap" INTEGER,
ADD COLUMN     "minQuestionsPerQuiz" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "pointsPerQuiz" INTEGER;

-- CreateTable
CREATE TABLE "CompetitionPointsEntry" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitionPointsEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitionDailyPoints" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CompetitionDailyPoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompetitionPointsEntry_competitionId_userId_idx" ON "CompetitionPointsEntry"("competitionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionPointsEntry_competitionId_sessionId_key" ON "CompetitionPointsEntry"("competitionId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionDailyPoints_competitionId_userId_day_key" ON "CompetitionDailyPoints"("competitionId", "userId", "day");

-- AddForeignKey
ALTER TABLE "CompetitionPointsEntry" ADD CONSTRAINT "CompetitionPointsEntry_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionPointsEntry" ADD CONSTRAINT "CompetitionPointsEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionDailyPoints" ADD CONSTRAINT "CompetitionDailyPoints_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionDailyPoints" ADD CONSTRAINT "CompetitionDailyPoints_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

