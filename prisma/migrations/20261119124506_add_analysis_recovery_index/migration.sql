-- CreateIndex
CREATE INDEX "security_analyses_status_processingLeaseUntil_idx" ON "security_analyses"("status", "processingLeaseUntil");
