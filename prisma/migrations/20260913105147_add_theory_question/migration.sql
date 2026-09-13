-- CreateTable
CREATE TABLE "TheoryQuestion" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classLevel" "ClassLevel" NOT NULL DEFAULT 'SS3',
    "topic" TEXT,
    "questionText" TEXT NOT NULL,
    "examType" "ExamType",
    "examYear" INTEGER,
    "paper" TEXT,
    "observation" TEXT,
    "generalComments" TEXT,
    "weaknessesRemedies" TEXT,
    "strengths" TEXT,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TheoryQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TheoryQuestion_subjectId_classLevel_idx" ON "TheoryQuestion"("subjectId", "classLevel");

-- CreateIndex
CREATE INDEX "TheoryQuestion_subjectId_examType_examYear_idx" ON "TheoryQuestion"("subjectId", "examType", "examYear");

-- AddForeignKey
ALTER TABLE "TheoryQuestion" ADD CONSTRAINT "TheoryQuestion_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
