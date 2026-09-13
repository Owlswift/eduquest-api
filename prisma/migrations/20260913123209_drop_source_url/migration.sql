/*
  Warnings:

  - You are about to drop the column `sourceUrl` on the `Question` table. All the data in the column will be lost.
  - You are about to drop the column `sourceUrl` on the `TheoryQuestion` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Question" DROP COLUMN "sourceUrl";

-- AlterTable
ALTER TABLE "TheoryQuestion" DROP COLUMN "sourceUrl";
