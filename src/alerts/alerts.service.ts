import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AlertState } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export interface AlertInput {
  number: number;
  packageName: string;
  ecosystem: string;
  severity: string | null;
  cveId: string | null;
  vulnerableVersion: string | null;
  patchedVersion: string | null;
  manifestPath: string | null;
  state: AlertState;
  firstDetectedAt: Date | null;
  lastUpdatedAt: Date | null;
}

@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  private getFingerprint(alert: AlertInput): string {
    const content = JSON.stringify([
      alert.packageName,
      alert.ecosystem,
      alert.severity,
      alert.cveId,
      alert.vulnerableVersion,
      alert.patchedVersion,
      alert.manifestPath,
      alert.state,
      alert.lastUpdatedAt?.toISOString() ?? null,
    ]);

    return createHash('sha256').update(content).digest('hex');
  }

  private hasChanged(
    existing: {
      packageName: string;
      ecosystem: string;
      severity: string | null;
      cveId: string | null;
      vulnerableVersion: string | null;
      patchedVersion: string | null;
      manifestPath: string | null;
      state: AlertState;
      lastUpdatedAt: Date | null;
    },
    incoming: AlertInput,
  ): boolean {
    return (
      existing.packageName !== incoming.packageName ||
      existing.ecosystem !== incoming.ecosystem ||
      existing.severity !== incoming.severity ||
      existing.cveId !== incoming.cveId ||
      existing.vulnerableVersion !== incoming.vulnerableVersion ||
      existing.patchedVersion !== incoming.patchedVersion ||
      existing.manifestPath !== incoming.manifestPath ||
      existing.state !== incoming.state ||
      existing.lastUpdatedAt?.getTime() !== incoming.lastUpdatedAt?.getTime()
    );
  }

  async syncAlerts(repositoryFullName: string, alerts: AlertInput[]) {
    const repository = await this.prisma.repository.findUnique({
      where: {
        fullName: repositoryFullName,
      },
    });

    if (!repository) {
      throw new NotFoundException(`Repository ${repositoryFullName} not found`);
    }

    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      let eventsCreated = 0;

      for (const alert of alerts) {
        const existing = await tx.securityAlert.findUnique({
          where: {
            repositoryId_alertNumber: {
              repositoryId: repository.id,
              alertNumber: alert.number,
            },
          },
        });

        const shouldCreateEvent =
          alert.state === AlertState.OPEN &&
          (!existing ||
            !existing.isPresent ||
            this.hasChanged(existing, alert));

        const savedAlert = await tx.securityAlert.upsert({
          where: {
            repositoryId_alertNumber: {
              repositoryId: repository.id,
              alertNumber: alert.number,
            },
          },
          create: {
            repositoryId: repository.id,
            alertNumber: alert.number,
            packageName: alert.packageName,
            ecosystem: alert.ecosystem,
            severity: alert.severity,
            cveId: alert.cveId,
            vulnerableVersion: alert.vulnerableVersion,
            patchedVersion: alert.patchedVersion,
            manifestPath: alert.manifestPath,
            state: alert.state,
            firstDetectedAt: alert.firstDetectedAt,
            lastUpdatedAt: alert.lastUpdatedAt,
            isPresent: true,
            lastSeenAt: now,
          },
          update: {
            packageName: alert.packageName,
            ecosystem: alert.ecosystem,
            severity: alert.severity,
            cveId: alert.cveId,
            vulnerableVersion: alert.vulnerableVersion,
            patchedVersion: alert.patchedVersion,
            manifestPath: alert.manifestPath,
            state: alert.state,
            lastUpdatedAt: alert.lastUpdatedAt,
            isPresent: true,
            lastSeenAt: now,
          },
        });

        if (shouldCreateEvent) {
          const fingerprint = this.getFingerprint(alert);

          const previousVersion = existing?.updatedAt
            ? existing.updatedAt.toISOString()
            : 'initial';

          await tx.outboxEvent.create({
            data: {
              eventType: 'SECURITY_ALERT_DETECTED',
              aggregateId: savedAlert.id,
              dedupeKey: [
                'dependabot',
                repository.id,
                alert.number,
                previousVersion,
                fingerprint,
              ].join(':'),
              payload: {
                schemaVersion: 1,
                securityAlertId: savedAlert.id,
                repositoryFullName,
                alertNumber: alert.number,
                fingerprint,
                alertSnapshot: {
                  number: alert.number,
                  packageName: alert.packageName,
                  ecosystem: alert.ecosystem,
                  severity: alert.severity,
                  cveId: alert.cveId,
                  vulnerableVersion: alert.vulnerableVersion,
                  patchedVersion: alert.patchedVersion,
                  manifestPath: alert.manifestPath,
                  state: alert.state,
                  firstDetectedAt: alert.firstDetectedAt?.toISOString() ?? null,
                  lastUpdatedAt: alert.lastUpdatedAt?.toISOString() ?? null,
                },
              },
            },
          });

          eventsCreated++;
        }
      }

      const currentAlertNumbers = alerts.map((alert) => alert.number);

      const reconciliation = await tx.securityAlert.updateMany({
        where: {
          repositoryId: repository.id,
          isPresent: true,
          ...(currentAlertNumbers.length > 0 && {
            alertNumber: {
              notIn: currentAlertNumbers,
            },
          }),
        },
        data: {
          isPresent: false,
        },
      });

      return {
        synced: alerts.length,
        markedAbsent: reconciliation.count,
        eventsCreated,
      };
    });
  }

  async findByRepository(repositoryId: string) {
    return this.prisma.securityAlert.findMany({
      where: {
        repositoryId,
      },
      orderBy: {
        lastUpdatedAt: 'desc',
      },
    });
  }
}
