-- AlterTable
ALTER TABLE "security_alerts" ADD COLUMN     "isPresent" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "security_alerts_repositoryId_isPresent_idx" ON "security_alerts"("repositoryId", "isPresent");
