-- AlterTable
ALTER TABLE "User" ADD COLUMN     "guardianConsentAt" TIMESTAMP(3),
ADD COLUMN     "guardianConsentVersion" TEXT,
ADD COLUMN     "guardianName" TEXT,
ADD COLUMN     "guardianPhone" TEXT,
ADD COLUMN     "policyAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "policyAcceptedVersion" TEXT;

