-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED');

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupeKey_key" ON "outbox_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateId_idx" ON "outbox_events"("aggregateId");
