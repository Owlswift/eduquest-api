-- CreateTable
CREATE TABLE "ScheduledRun" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledRun_startedAt_idx" ON "ScheduledRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledRun_task_slot_key" ON "ScheduledRun"("task", "slot");

