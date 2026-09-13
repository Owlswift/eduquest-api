-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "topic" TEXT;

-- CreateIndex
CREATE INDEX "Question_subjectId_topic_idx" ON "Question"("subjectId", "topic");
