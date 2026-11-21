import { NotFoundException } from '@nestjs/common';
import { AnalysisStatus } from '@prisma/client';

import { AnalysisService } from './analysis.service';
import { PrismaService } from '../database/prisma.service';

describe('AnalysisService', () => {
  let service: AnalysisService;

  const event = {
    id: 'event-uuid',
    eventType: 'SECURITY_ALERT_DETECTED',
    payload: {
      schemaVersion: 1,
      securityAlertId: 'alert-uuid',
      alertSnapshot: {
        number: 42,
        packageName: 'lodash',
        severity: 'high',
      },
      repositoryFullName: 'integration-test/repository',
      alertNumber: 42,
      fingerprint: 'test-fingerprint',
    },
  };

  const tx = {
    outboxEvent: {
      findUnique: jest.fn(),
    },
    securityAlert: {
      findUnique: jest.fn(),
    },
    securityAnalysis: {
      upsert: jest.fn(),
    },
  };

  const prisma = {
    $transaction: jest.fn(),
    securityAnalysis: {
      updateMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );

    tx.outboxEvent.findUnique.mockResolvedValue(event);

    tx.securityAlert.findUnique.mockResolvedValue({
      id: 'alert-uuid',
    });

    tx.securityAnalysis.upsert.mockResolvedValue({
      id: 'analysis-uuid',
      status: AnalysisStatus.PENDING,
    });

    prisma.securityAnalysis.updateMany.mockResolvedValue({
      count: 1,
    });

    service = new AnalysisService(prisma as unknown as PrismaService);
  });

  it('registers a pending analysis', async () => {
    const result = await service.registerPendingAnalysis('event-uuid');

    expect(result.analysis.status).toBe(AnalysisStatus.PENDING);

    expect(result.workflowInput).toEqual({
      eventId: 'event-uuid',
      securityAlertId: 'alert-uuid',
      repositoryFullName: 'integration-test/repository',
      alertNumber: 42,
      fingerprint: 'test-fingerprint',
      alertSnapshot: event.payload.alertSnapshot,
    });
  });

  it('does not recreate an existing analysis', async () => {
    const existingAnalysis = {
      id: 'analysis-uuid',
      status: AnalysisStatus.COMPLETED,
      result: { summary: 'Already analyzed' },
    };

    tx.securityAnalysis.upsert.mockResolvedValue(existingAnalysis);

    const result = await service.registerPendingAnalysis('event-uuid');

    expect(result.analysis).toEqual(existingAnalysis);
    expect(tx.securityAnalysis.upsert).toHaveBeenCalledTimes(1);
    expect(tx.securityAnalysis.upsert.mock.calls[0][0].update).toEqual({});
  });

  it('throws when the outbox event does not exist', async () => {
    tx.outboxEvent.findUnique.mockResolvedValue(null);

    await expect(
      service.registerPendingAnalysis('missing-event'),
    ).rejects.toThrow(NotFoundException);

    expect(tx.securityAnalysis.upsert).not.toHaveBeenCalled();
  });

  it('rejects unsupported event types', async () => {
    tx.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      eventType: 'UNKNOWN_EVENT',
    });

    await expect(service.registerPendingAnalysis('event-uuid')).rejects.toThrow(
      'Unsupported event type',
    );

    expect(tx.securityAnalysis.upsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid event payload', async () => {
    tx.outboxEvent.findUnique.mockResolvedValue({
      ...event,
      payload: {
        schemaVersion: 1,
        securityAlertId: 'alert-uuid',
      },
    });

    await expect(service.registerPendingAnalysis('event-uuid')).rejects.toThrow(
      'Invalid security alert event structure',
    );

    expect(tx.securityAnalysis.upsert).not.toHaveBeenCalled();
  });

  it('throws when the security alert does not exist', async () => {
    tx.securityAlert.findUnique.mockResolvedValue(null);

    await expect(service.registerPendingAnalysis('event-uuid')).rejects.toThrow(
      NotFoundException,
    );

    expect(tx.securityAnalysis.upsert).not.toHaveBeenCalled();
  });

  it('completes an analysis only for the current processing token', async () => {
    const result = { summary: 'Vulnerability analyzed' };

    const completed = await service.completeAnalysis(
      'analysis-uuid',
      'processing-token',
      result,
    );

    expect(completed).toBe(true);

    expect(prisma.securityAnalysis.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'analysis-uuid',
        status: AnalysisStatus.PROCESSING,
        processingToken: 'processing-token',
      },
      data: expect.objectContaining({
        status: AnalysisStatus.COMPLETED,
        result,
        processingToken: null,
        processingLeaseUntil: null,
        lastError: null,
        completedAt: expect.any(Date),
      }),
    });
  });

  it('does not complete an analysis when the processing token is stale', async () => {
    prisma.securityAnalysis.updateMany.mockResolvedValue({
      count: 0,
    });

    const completed = await service.completeAnalysis(
      'analysis-uuid',
      'stale-token',
      { summary: 'Result' },
    );

    expect(completed).toBe(false);
  });

  it('marks an analysis as failed for the current processing token', async () => {
    const failed = await service.failAnalysis(
      'analysis-uuid',
      'processing-token',
      new Error('AI provider unavailable'),
    );

    expect(failed).toBe(true);

    expect(prisma.securityAnalysis.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'analysis-uuid',
        status: AnalysisStatus.PROCESSING,
        processingToken: 'processing-token',
      },
      data: {
        status: AnalysisStatus.FAILED,
        lastError: 'AI provider unavailable',
        processingToken: null,
        processingLeaseUntil: null,
      },
    });
  });

  it('does not mark an analysis as failed when the processing token is stale', async () => {
    prisma.securityAnalysis.updateMany.mockResolvedValue({
      count: 0,
    });

    const failed = await service.failAnalysis(
      'analysis-uuid',
      'stale-token',
      new Error('Workflow failed'),
    );

    expect(failed).toBe(false);
  });
});
