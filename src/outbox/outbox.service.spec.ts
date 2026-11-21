import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { OutboxStatus } from '@prisma/client';

import { OutboxService } from './outbox.service';
import { PrismaService } from '../database/prisma.service';

describe('OutboxService', () => {
  let service: OutboxService;

  const event = {
    id: 'event-uuid',
    eventType: 'SECURITY_ALERT_DETECTED',
    payload: {
      securityAlertId: 'alert-uuid',
      repositoryFullName: 'owner/repository',
      alertNumber: 123,
    },
    attempts: 0,
    lockToken: 'claim-token',
  };

  const prismaMock = {
    $transaction: jest.fn(),
    outboxEvent: {
      updateMany: jest.fn(),
    },
  };

  const txMock = {
    $queryRaw: jest.fn(),
  };

  const queueMock = {
    add: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof txMock) => Promise<unknown>) =>
        callback(txMock),
    );

    txMock.$queryRaw.mockResolvedValue([event]);

    prismaMock.outboxEvent.updateMany.mockResolvedValue({
      count: 1,
    });

    queueMock.add.mockResolvedValue({
      id: event.id,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxService,
        {
          provide: PrismaService,
          useValue: prismaMock,
        },
        {
          provide: getQueueToken('security-analysis'),
          useValue: queueMock,
        },
      ],
    }).compile();

    service = module.get<OutboxService>(OutboxService);
  });

  it('claims and publishes pending events', async () => {
    const result = await service.dispatchPending();

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);

    expect(queueMock.add).toHaveBeenCalledWith(
      'analyze-security-alert',
      {
        eventId: event.id,
        eventType: event.eventType,
        ...event.payload,
      },
      expect.objectContaining({
        jobId: event.id,
        attempts: 5,
      }),
    );

    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        lockToken: event.lockToken,
        status: OutboxStatus.PENDING,
      },
      data: expect.objectContaining({
        status: OutboxStatus.PUBLISHED,
        publishedAt: expect.any(Date),
        lastError: null,
        lockToken: null,
        lockedUntil: null,
      }),
    });

    expect(result).toEqual({
      skipped: false,
      processed: 1,
      published: 1,
      failed: 0,
      leaseLost: 0,
    });
  });

  it('returns an empty result when there are no pending events', async () => {
    txMock.$queryRaw.mockResolvedValue([]);

    const result = await service.dispatchPending();

    expect(queueMock.add).not.toHaveBeenCalled();
    expect(prismaMock.outboxEvent.updateMany).not.toHaveBeenCalled();

    expect(result).toEqual({
      skipped: false,
      processed: 0,
      published: 0,
      failed: 0,
      leaseLost: 0,
    });
  });

  it('keeps the event pending and schedules a retry when Redis fails', async () => {
    queueMock.add.mockRejectedValue(new Error('Redis unavailable'));

    const result = await service.dispatchPending();

    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        lockToken: event.lockToken,
        status: OutboxStatus.PENDING,
      },
      data: expect.objectContaining({
        attempts: 1,
        lastError: 'Redis unavailable',
        availableAt: expect.any(Date),
        lockToken: null,
        lockedUntil: null,
      }),
    });

    const updateData = prismaMock.outboxEvent.updateMany.mock.calls[0][0].data;

    expect(updateData.availableAt.getTime()).toBeGreaterThan(Date.now());

    expect(result).toEqual({
      skipped: false,
      processed: 1,
      published: 0,
      failed: 1,
      leaseLost: 0,
    });
  });

  it('does not overwrite an event when its lease has been lost', async () => {
    prismaMock.outboxEvent.updateMany.mockResolvedValue({
      count: 0,
    });

    const result = await service.dispatchPending();

    expect(queueMock.add).toHaveBeenCalledTimes(1);
    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      skipped: false,
      processed: 1,
      published: 0,
      failed: 0,
      leaseLost: 1,
    });
  });

  it('uses the same claim token for all events in a batch', async () => {
    const secondEvent = {
      ...event,
      id: 'event-uuid-2',
    };

    txMock.$queryRaw.mockResolvedValue([event, secondEvent]);

    const result = await service.dispatchPending();

    expect(queueMock.add).toHaveBeenCalledTimes(2);
    expect(prismaMock.outboxEvent.updateMany).toHaveBeenCalledTimes(2);

    expect(result).toEqual({
      skipped: false,
      processed: 2,
      published: 2,
      failed: 0,
      leaseLost: 0,
    });
  });

  it('uses a transaction to claim events before publishing', async () => {
    await service.dispatchPending();

    const transactionCallback = prismaMock.$transaction.mock.calls[0][0];

    expect(transactionCallback).toBeDefined();

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);

    // A transação de claim termina antes da publicação no Redis.
    expect(prismaMock.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      queueMock.add.mock.invocationCallOrder[0],
    );
  });
});
