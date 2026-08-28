-- CreateEnum
CREATE TYPE "CurriculumImportStatus" AS ENUM ('UPLOADED', 'EXTRACTING', 'EXTRACTED', 'EXTRACTION_FAILED', 'REVIEWED', 'SAVED');

-- CreateTable
CREATE TABLE "CurriculumImport" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classLevel" "ClassLevel" NOT NULL,
    "fileName" TEXT NOT NULL,
    "pageCount" INTEGER,
    "rawPages" JSONB,
    "extractedJson" JSONB,
    "validationErrors" JSONB,
    "status" "CurriculumImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurriculumImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurriculumTopic" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classLevel" "ClassLevel" NOT NULL,
    "importId" TEXT,
    "theme" TEXT NOT NULL,
    "learningOutcome" TEXT NOT NULL,
    "focalCompetence" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "performanceObjectives" JSONB NOT NULL,
    "content" JSONB NOT NULL,
    "keyCompetenciesAndValues" JSONB NOT NULL,
    "learningActivities" JSONB NOT NULL,
    "teachingLearningResources" JSONB NOT NULL,
    "evaluationGuide" JSONB NOT NULL,
    "sourcePage" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurriculumTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CurriculumImport_subjectId_classLevel_idx" ON "CurriculumImport"("subjectId", "classLevel");

-- CreateIndex
CREATE INDEX "CurriculumTopic_subjectId_classLevel_idx" ON "CurriculumTopic"("subjectId", "classLevel");

-- CreateIndex
CREATE UNIQUE INDEX "CurriculumTopic_subjectId_classLevel_theme_topic_key" ON "CurriculumTopic"("subjectId", "classLevel", "theme", "topic");

-- AddForeignKey
ALTER TABLE "CurriculumImport" ADD CONSTRAINT "CurriculumImport_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurriculumTopic" ADD CONSTRAINT "CurriculumTopic_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurriculumTopic" ADD CONSTRAINT "CurriculumTopic_importId_fkey" FOREIGN KEY ("importId") REFERENCES "CurriculumImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
