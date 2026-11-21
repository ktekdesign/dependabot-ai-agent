-- AlterTable
ALTER TABLE "security_analyses" ADD COLUMN     "processingLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "processingToken" TEXT;
