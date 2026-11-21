-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "security_analyses" (
    "id" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "securityAlertId" UUID NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "alertSnapshot" JSONB NOT NULL,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "security_analyses_outboxEventId_key" ON "security_analyses"("outboxEventId");

-- CreateIndex
CREATE INDEX "security_analyses_securityAlertId_createdAt_idx" ON "security_analyses"("securityAlertId", "createdAt");

-- CreateIndex
CREATE INDEX "security_analyses_status_updatedAt_idx" ON "security_analyses"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "security_analyses" ADD CONSTRAINT "security_analyses_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_analyses" ADD CONSTRAINT "security_analyses_securityAlertId_fkey" FOREIGN KEY ("securityAlertId") REFERENCES "security_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
