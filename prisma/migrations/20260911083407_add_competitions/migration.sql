-- CreateTable
CREATE TABLE "Competition" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL,
    "prizes" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Competition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitionParticipant" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "xpAtJoin" INTEGER NOT NULL DEFAULT 0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitionParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Competition_startsAt_endsAt_idx" ON "Competition"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "CompetitionParticipant_competitionId_idx" ON "CompetitionParticipant"("competitionId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionParticipant_competitionId_userId_key" ON "CompetitionParticipant"("competitionId", "userId");

-- AddForeignKey
ALTER TABLE "CompetitionParticipant" ADD CONSTRAINT "CompetitionParticipant_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitionParticipant" ADD CONSTRAINT "CompetitionParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
