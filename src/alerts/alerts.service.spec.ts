import { NotFoundException } from '@nestjs/common';
import { AlertState } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../database/prisma.service';
import { AlertsService, AlertInput } from './alerts.service';

describe('AlertsService', () => {
  let service: AlertsService;
  let prisma: any;
  let transaction: any;

  const repository = {
    id: 'repository-uuid',
    fullName: 'ktekdesign/backend',
  };

  const createAlert = (overrides: Partial<AlertInput> = {}): AlertInput => ({
    number: 101,
    packageName: 'lodash',
    ecosystem: 'npm',
    severity: 'high',
    cveId: 'CVE-2026-12345',
    vulnerableVersion: '< 4.17.21',
    patchedVersion: '4.17.21',
    manifestPath: 'package-lock.json',
    state: AlertState.OPEN,
    firstDetectedAt: new Date('2026-01-01T00:00:00Z'),
    lastUpdatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  });

  const existingAlert = (
    alert: AlertInput,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: 'alert-uuid',
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
    ...overrides,
  });

  const getExpectedFingerprint = (alert: AlertInput): string => {
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
  };

  beforeEach(() => {
    transaction = {
      securityAlert: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'alert-uuid' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-uuid' }),
      },
    };

    prisma = {
      repository: {
        findUnique: jest.fn().mockResolvedValue(repository),
      },
      $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) =>
        callback(transaction),
      ),
    };

    service = new AlertsService(prisma as unknown as PrismaService);
  });

  describe('syncAlerts', () => {
    it('should throw NotFoundException when repository does not exist', async () => {
      prisma.repository.findUnique.mockResolvedValue(null);

      await expect(
        service.syncAlerts('unknown/repository', []),
      ).rejects.toThrow(NotFoundException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should upsert a new alert and create an outbox event with an immutable snapshot', async () => {
      const alert = createAlert();

      const result = await service.syncAlerts(repository.fullName, [alert]);

      const expectedFingerprint = getExpectedFingerprint(alert);

      expect(transaction.securityAlert.findUnique).toHaveBeenCalled();

      expect(transaction.securityAlert.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            repositoryId: repository.id,
            alertNumber: alert.number,
            packageName: alert.packageName,
            state: AlertState.OPEN,
            isPresent: true,
            lastSeenAt: expect.any(Date),
          }),
        }),
      );

      expect(transaction.outboxEvent.create).toHaveBeenCalledWith({
        data: {
          eventType: 'SECURITY_ALERT_DETECTED',
          aggregateId: 'alert-uuid',
          dedupeKey: [
            'dependabot',
            repository.id,
            alert.number,
            'initial',
            expectedFingerprint,
          ].join(':'),
          payload: {
            schemaVersion: 1,
            securityAlertId: 'alert-uuid',
            repositoryFullName: repository.fullName,
            alertNumber: alert.number,
            fingerprint: expectedFingerprint,
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
              firstDetectedAt: '2026-01-01T00:00:00.000Z',
              lastUpdatedAt: '2026-01-02T00:00:00.000Z',
            },
          },
        },
      });

      expect(result).toEqual({
        synced: 1,
        markedAbsent: 0,
        eventsCreated: 1,
      });
    });

    it('should not create an event for an unchanged alert', async () => {
      const alert = createAlert();

      transaction.securityAlert.findUnique.mockResolvedValue(
        existingAlert(alert),
      );

      const result = await service.syncAlerts(repository.fullName, [alert]);

      expect(transaction.securityAlert.upsert).toHaveBeenCalledTimes(1);
      expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
      expect(result.eventsCreated).toBe(0);
    });

    it('should create an event when an existing alert changes', async () => {
      const alert = createAlert();

      transaction.securityAlert.findUnique.mockResolvedValue(
        existingAlert(alert, {
          severity: 'medium',
        }),
      );

      const result = await service.syncAlerts(repository.fullName, [alert]);

      expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
      expect(result.eventsCreated).toBe(1);
    });

    it('should create an event when an absent alert reappears', async () => {
      const alert = createAlert();

      transaction.securityAlert.findUnique.mockResolvedValue(
        existingAlert(alert, {
          isPresent: false,
        }),
      );

      const result = await service.syncAlerts(repository.fullName, [alert]);

      expect(transaction.outboxEvent.create).toHaveBeenCalledTimes(1);
      expect(result.eventsCreated).toBe(1);
    });

    it('should not create events for non-open alerts', async () => {
      const alert = createAlert({
        state: AlertState.DISMISSED,
      });

      const result = await service.syncAlerts(repository.fullName, [alert]);

      expect(transaction.securityAlert.upsert).toHaveBeenCalledTimes(1);
      expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
      expect(result.eventsCreated).toBe(0);
    });

    it('should mark alerts absent when they are missing from the snapshot', async () => {
      const alerts = [
        createAlert({ number: 101 }),
        createAlert({ number: 102 }),
      ];

      await service.syncAlerts(repository.fullName, alerts);

      expect(transaction.securityAlert.updateMany).toHaveBeenCalledWith({
        where: {
          repositoryId: repository.id,
          isPresent: true,
          alertNumber: {
            notIn: [101, 102],
          },
        },
        data: {
          isPresent: false,
        },
      });
    });

    it('should reconcile all previous alerts when the snapshot is empty', async () => {
      const result = await service.syncAlerts(repository.fullName, []);

      expect(transaction.securityAlert.upsert).not.toHaveBeenCalled();

      expect(transaction.securityAlert.updateMany).toHaveBeenCalledWith({
        where: {
          repositoryId: repository.id,
          isPresent: true,
        },
        data: {
          isPresent: false,
        },
      });

      expect(result).toEqual({
        synced: 0,
        markedAbsent: 0,
        eventsCreated: 0,
      });
    });
  });
});
