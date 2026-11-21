import { AlertState } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { PrismaService } from '../src/database/prisma.service';
import { AlertsService, AlertInput } from '../src/alerts/alerts.service';

describe('AlertsService (integration)', () => {
  let prisma: PrismaService;
  let alertsService: AlertsService;
  let repositoryId: string;
  let repositoryFullName: string;

  const createAlert = (overrides: Partial<AlertInput> = {}): AlertInput => ({
    number: 1,
    packageName: 'lodash',
    ecosystem: 'npm',
    severity: 'high',
    cveId: 'CVE-TEST-001',
    vulnerableVersion: '< 4.17.21',
    patchedVersion: '4.17.21',
    manifestPath: 'package-lock.json',
    state: AlertState.OPEN,
    firstDetectedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastUpdatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  });

  const getFingerprint = (alert: AlertInput): string => {
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

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    alertsService = new AlertsService(prisma);
  });

  beforeEach(async () => {
    const suffix = randomUUID();
    repositoryFullName = `integration-test/${suffix}`;

    const repository = await prisma.repository.create({
      data: {
        githubId: BigInt(Date.now()),
        owner: 'integration-test',
        name: suffix,
        fullName: repositoryFullName,
        monitoringStatus: 'ENABLED',
      },
    });

    repositoryId = repository.id;
  });

  afterEach(async () => {
    const alerts = await prisma.securityAlert.findMany({
      where: { repositoryId },
      select: { id: true },
    });

    await prisma.outboxEvent.deleteMany({
      where: {
        aggregateId: {
          in: alerts.map((alert) => alert.id),
        },
      },
    });

    await prisma.repository.deleteMany({
      where: { id: repositoryId },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should persist an alert and its complete snapshot in PostgreSQL', async () => {
    const alert = createAlert();

    const result = await alertsService.syncAlerts(repositoryFullName, [alert]);

    const storedAlerts = await prisma.securityAlert.findMany({
      where: { repositoryId },
    });

    expect(result.synced).toBe(1);
    expect(result.eventsCreated).toBe(1);
    expect(storedAlerts).toHaveLength(1);
    expect(storedAlerts[0].packageName).toBe('lodash');
    expect(storedAlerts[0].isPresent).toBe(true);

    const outboxEvent = await prisma.outboxEvent.findFirst({
      where: {
        aggregateId: storedAlerts[0].id,
        eventType: 'SECURITY_ALERT_DETECTED',
      },
    });

    expect(outboxEvent).not.toBeNull();
    expect(outboxEvent?.status).toBe('PENDING');

    const payload = outboxEvent?.payload as {
      schemaVersion: number;
      securityAlertId: string;
      repositoryFullName: string;
      alertNumber: number;
      fingerprint: string;
      alertSnapshot: Record<string, unknown>;
    };

    const expectedFingerprint = getFingerprint(alert);

    expect(payload).toEqual({
      schemaVersion: 1,
      securityAlertId: storedAlerts[0].id,
      repositoryFullName,
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
        firstDetectedAt: alert.firstDetectedAt?.toISOString(),
        lastUpdatedAt: alert.lastUpdatedAt?.toISOString(),
      },
    });

    expect(outboxEvent?.dedupeKey).toContain(expectedFingerprint);
  });

  it('should not create duplicate events when an unchanged alert is synchronized again', async () => {
    const alert = createAlert();

    const firstResult = await alertsService.syncAlerts(repositoryFullName, [
      alert,
    ]);

    const secondResult = await alertsService.syncAlerts(repositoryFullName, [
      alert,
    ]);

    const storedAlerts = await prisma.securityAlert.findMany({
      where: { repositoryId },
    });

    const events = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: storedAlerts[0].id,
        eventType: 'SECURITY_ALERT_DETECTED',
      },
    });

    expect(firstResult.eventsCreated).toBe(1);
    expect(secondResult.eventsCreated).toBe(0);
    expect(storedAlerts).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('should update an existing alert and create a new version event', async () => {
    const alert = createAlert({
      number: 2,
      packageName: 'axios',
      severity: 'moderate',
      cveId: null,
      vulnerableVersion: '< 1.0.0',
      patchedVersion: '1.0.0',
    });

    await alertsService.syncAlerts(repositoryFullName, [alert]);

    await alertsService.syncAlerts(repositoryFullName, [
      { ...alert, severity: 'high' },
    ]);

    const storedAlerts = await prisma.securityAlert.findMany({
      where: { repositoryId },
    });

    expect(storedAlerts).toHaveLength(1);
    expect(storedAlerts[0].severity).toBe('high');

    const events = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: storedAlerts[0].id,
        eventType: 'SECURITY_ALERT_DETECTED',
      },
      orderBy: { createdAt: 'asc' },
    });

    expect(events).toHaveLength(2);

    const firstPayload = events[0].payload as {
      alertSnapshot: { severity: string };
    };

    const secondPayload = events[1].payload as {
      alertSnapshot: { severity: string };
    };

    expect(firstPayload.alertSnapshot.severity).toBe('moderate');
    expect(secondPayload.alertSnapshot.severity).toBe('high');
  });

  it('should mark alerts absent when they are missing from the snapshot', async () => {
    await alertsService.syncAlerts(repositoryFullName, [
      createAlert({
        number: 3,
        packageName: 'express',
        cveId: null,
        vulnerableVersion: '< 4.18.0',
        patchedVersion: '4.18.0',
      }),
    ]);

    await alertsService.syncAlerts(repositoryFullName, []);

    const storedAlert = await prisma.securityAlert.findUnique({
      where: {
        repositoryId_alertNumber: {
          repositoryId,
          alertNumber: 3,
        },
      },
    });

    expect(storedAlert).not.toBeNull();
    expect(storedAlert?.isPresent).toBe(false);
  });

  it('should rollback all changes when an alert fails to persist', async () => {
    const validAlert = createAlert({
      number: 10,
    });

    const invalidAlert = createAlert({
      number: 11,
      packageName: 'axios',
      state: 'INVALID_STATE' as AlertState,
    });

    await expect(
      alertsService.syncAlerts(repositoryFullName, [validAlert, invalidAlert]),
    ).rejects.toThrow();

    const storedAlerts = await prisma.securityAlert.findMany({
      where: { repositoryId },
    });

    const storedEvents = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: {
          in: storedAlerts.map((alert) => alert.id),
        },
      },
    });

    expect(storedAlerts).toHaveLength(0);
    expect(storedEvents).toHaveLength(0);
  });
});
