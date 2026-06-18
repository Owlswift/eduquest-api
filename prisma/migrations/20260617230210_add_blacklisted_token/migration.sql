-- CreateTable
CREATE TABLE "BlacklistedToken" (
    "id" TEXT NOT NULL,
    "tokenJti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlacklistedToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlacklistedToken_tokenJti_key" ON "BlacklistedToken"("tokenJti");

-- CreateIndex
CREATE INDEX "BlacklistedToken_tokenJti_idx" ON "BlacklistedToken"("tokenJti");

-- CreateIndex
CREATE INDEX "BlacklistedToken_expiresAt_idx" ON "BlacklistedToken"("expiresAt");
