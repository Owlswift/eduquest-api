-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED');

-- AlterTable
ALTER TABLE "QuizSession" ADD COLUMN     "dailyChallengeId" TEXT;

-- CreateTable
CREATE TABLE "DailyChallenge" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "classLevel" "ClassLevel" NOT NULL,
    "questionIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "examType" "ExamType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "questionIds" TEXT[],
    "durationSec" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "status" "ExamStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "score" INTEGER,
    "pastQuestionsOnly" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ExamSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyChallenge_date_classLevel_key" ON "DailyChallenge"("date", "classLevel");

-- CreateIndex
CREATE INDEX "ExamSession_userId_status_idx" ON "ExamSession"("userId", "status");

-- CreateIndex
CREATE INDEX "ExamSession_userId_startedAt_idx" ON "ExamSession"("userId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuizSession_userId_dailyChallengeId_key" ON "QuizSession"("userId", "dailyChallengeId");

-- AddForeignKey
ALTER TABLE "QuizSession" ADD CONSTRAINT "QuizSession_dailyChallengeId_fkey" FOREIGN KEY ("dailyChallengeId") REFERENCES "DailyChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamSession" ADD CONSTRAINT "ExamSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
