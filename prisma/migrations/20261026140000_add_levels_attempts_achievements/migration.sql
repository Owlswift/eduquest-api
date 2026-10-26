-- CreateEnum
CREATE TYPE "AttemptSource" AS ENUM ('QUIZ', 'STARTER', 'CHALLENGE', 'DAILY', 'EXAM');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "longestStreak" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "QuizSession" ADD COLUMN     "correctCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "QuestionAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "topic" TEXT,
    "selectedOptionId" TEXT,
    "correct" BOOLEAN NOT NULL,
    "source" "AttemptSource" NOT NULL,
    "sourceRefId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserAchievement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionAttempt_userId_sourceRefId_questionId_key" ON "QuestionAttempt"("userId", "sourceRefId", "questionId");

-- CreateIndex
CREATE INDEX "QuestionAttempt_userId_subjectId_createdAt_idx" ON "QuestionAttempt"("userId", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "QuestionAttempt_userId_subjectId_topic_idx" ON "QuestionAttempt"("userId", "subjectId", "topic");

-- CreateIndex
CREATE INDEX "QuestionAttempt_questionId_idx" ON "QuestionAttempt"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "UserAchievement_userId_key_key" ON "UserAchievement"("userId", "key");

-- CreateIndex
CREATE INDEX "UserAchievement_userId_idx" ON "UserAchievement"("userId");

-- AddForeignKey
ALTER TABLE "QuestionAttempt" ADD CONSTRAINT "QuestionAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAchievement" ADD CONSTRAINT "UserAchievement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the level curve (see src/modules/gamification/levels.ts).
-- XP needed to go from level L to L+1 is 400 + 100*L, so the total XP at
-- which level L starts is (L-1)*400 + 50*(L-1)*L. `maxXp` is the total XP at
-- which the NEXT level starts. Capped at level 100.
UPDATE "User" u
   SET "level" = l.lvl,
       "maxXp" = l.lvl * 400 + 50 * l.lvl * (l.lvl + 1)
  FROM (
    SELECT id,
           (SELECT max(n) FROM generate_series(1, 100) n
             WHERE (n - 1) * 400 + 50 * (n - 1) * n <= "User"."xp") AS lvl
      FROM "User"
  ) l
 WHERE u.id = l.id;

-- Backfill: longest streak is at least the current streak.
UPDATE "User" SET "longestStreak" = "streak";

-- Backfill: `badges` becomes the number of unlocked achievements, which the
-- achievements service recounts on the next evaluation. Reset it so the old
-- ad-hoc counter (First Steps only) is not double counted.
UPDATE "User" SET "badges" = 0;
