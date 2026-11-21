-- CreateEnum
CREATE TYPE "MonitoringStatus" AS ENUM ('PENDING', 'ENABLED', 'NOT_ENABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "AlertState" AS ENUM ('OPEN', 'DISMISSED', 'FIXED');

-- CreateTable
CREATE TABLE "repositories" (
    "id" UUID NOT NULL,
    "githubId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "monitoringStatus" "MonitoringStatus" NOT NULL DEFAULT 'PENDING',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_alerts" (
    "id" UUID NOT NULL,
    "repositoryId" UUID NOT NULL,
    "alertNumber" INTEGER NOT NULL,
    "packageName" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "severity" TEXT,
    "cveId" TEXT,
    "vulnerableVersion" TEXT,
    "patchedVersion" TEXT,
    "manifestPath" TEXT,
    "state" "AlertState" NOT NULL DEFAULT 'OPEN',
    "firstDetectedAt" TIMESTAMP(3),
    "lastUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repositories_githubId_key" ON "repositories"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_fullName_key" ON "repositories"("fullName");

-- CreateIndex
CREATE INDEX "security_alerts_state_severity_idx" ON "security_alerts"("state", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "security_alerts_repositoryId_alertNumber_key" ON "security_alerts"("repositoryId", "alertNumber");

-- AddForeignKey
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
