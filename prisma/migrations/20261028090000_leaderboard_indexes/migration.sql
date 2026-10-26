-- CreateIndex
CREATE INDEX "DailyActivity_date_idx" ON "DailyActivity"("date");

-- CreateIndex
CREATE INDEX "QuestionAttempt_subjectId_createdAt_idx" ON "QuestionAttempt"("subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "SubjectStat_subjectId_correctAnswers_idx" ON "SubjectStat"("subjectId", "correctAnswers");

-- CreateIndex
CREATE INDEX "User_xp_idx" ON "User"("xp");

-- CreateIndex
CREATE INDEX "User_state_xp_idx" ON "User"("state", "xp");

-- CreateIndex
CREATE INDEX "User_classLevel_xp_idx" ON "User"("classLevel", "xp");

