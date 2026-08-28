-- CreateEnum
CREATE TYPE "LessonState" AS ENUM ('INTRODUCTION', 'ASSESS_PRIOR_KNOWLEDGE', 'EXPLAIN_CONCEPT', 'EXAMPLE', 'CHECK_UNDERSTANDING', 'MINI_QUIZ', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TutorMessageRole" AS ENUM ('TUTOR', 'STUDENT');

-- CreateTable
CREATE TABLE "TutorSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classLevel" "ClassLevel" NOT NULL,
    "topicId" TEXT NOT NULL,
    "state" "LessonState" NOT NULL DEFAULT 'INTRODUCTION',
    "masteryAtStart" INTEGER,
    "weakAreasAtStart" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TutorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TutorMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "TutorMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "blocks" JSONB,
    "stateAt" "LessonState" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TutorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentMastery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classLevel" "ClassLevel" NOT NULL,
    "topicId" TEXT NOT NULL,
    "masteryScore" INTEGER NOT NULL DEFAULT 0,
    "weakAreas" JSONB,
    "lastStudiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentMastery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TutorSession_userId_subjectId_classLevel_idx" ON "TutorSession"("userId", "subjectId", "classLevel");

-- CreateIndex
CREATE INDEX "TutorMessage_sessionId_idx" ON "TutorMessage"("sessionId");

-- CreateIndex
CREATE INDEX "StudentMastery_userId_subjectId_classLevel_idx" ON "StudentMastery"("userId", "subjectId", "classLevel");

-- CreateIndex
CREATE UNIQUE INDEX "StudentMastery_userId_topicId_key" ON "StudentMastery"("userId", "topicId");

-- AddForeignKey
ALTER TABLE "TutorSession" ADD CONSTRAINT "TutorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorSession" ADD CONSTRAINT "TutorSession_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorSession" ADD CONSTRAINT "TutorSession_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "CurriculumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TutorMessage" ADD CONSTRAINT "TutorMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TutorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentMastery" ADD CONSTRAINT "StudentMastery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentMastery" ADD CONSTRAINT "StudentMastery_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "CurriculumTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
