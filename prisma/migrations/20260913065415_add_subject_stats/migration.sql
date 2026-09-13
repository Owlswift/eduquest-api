-- CreateTable
CREATE TABLE "SubjectStat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "questionsAnswered" INTEGER NOT NULL DEFAULT 0,
    "correctAnswers" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubjectStat_subjectId_idx" ON "SubjectStat"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "SubjectStat_userId_subjectId_key" ON "SubjectStat"("userId", "subjectId");

-- AddForeignKey
ALTER TABLE "SubjectStat" ADD CONSTRAINT "SubjectStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
