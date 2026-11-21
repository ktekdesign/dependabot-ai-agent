-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "lockToken" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "outbox_events_status_lockedUntil_idx" ON "outbox_events"("status", "lockedUntil");
