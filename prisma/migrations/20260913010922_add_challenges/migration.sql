-- CreateEnum
CREATE TYPE "ChallengeStatus" AS ENUM ('PENDING', 'DECLINED', 'ACTIVE', 'COMPLETED');

-- CreateTable
CREATE TABLE "Challenge" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classLevel" "ClassLevel" NOT NULL,
    "challengerId" TEXT NOT NULL,
    "opponentId" TEXT NOT NULL,
    "challengerTopics" JSONB NOT NULL,
    "opponentTopics" JSONB,
    "status" "ChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "questionIds" TEXT[],
    "challengerOptionOrder" JSONB,
    "opponentOptionOrder" JSONB,
    "challengerAnswers" JSONB,
    "opponentAnswers" JSONB,
    "challengerScore" INTEGER,
    "opponentScore" INTEGER,
    "challengerCompletedAt" TIMESTAMP(3),
    "opponentCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Challenge_challengerId_status_idx" ON "Challenge"("challengerId", "status");

-- CreateIndex
CREATE INDEX "Challenge_opponentId_status_idx" ON "Challenge"("opponentId", "status");

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_challengerId_fkey" FOREIGN KEY ("challengerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Challenge" ADD CONSTRAINT "Challenge_opponentId_fkey" FOREIGN KEY ("opponentId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
