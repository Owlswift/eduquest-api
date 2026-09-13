-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "examType" "ExamType",
ADD COLUMN     "examYear" INTEGER,
ADD COLUMN     "sourceUrl" TEXT;

-- CreateIndex
CREATE INDEX "Question_subjectId_examType_examYear_idx" ON "Question"("subjectId", "examType", "examYear");
