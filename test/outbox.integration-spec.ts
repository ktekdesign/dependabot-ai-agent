import { OutboxStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../src/database/prisma.service';
import { OutboxService } from '../src/outbox/outbox.service';

describe('OutboxService (integration)', () => {
  let prisma: PrismaService;
  let service: OutboxService;

  let prefix: string;

  const queueMock = {
    add: jest.fn(),
  };

  async function createEvent(
    overrides: Partial<Prisma.OutboxEventUncheckedCreateInput> = {},
  ) {
    return prisma.outboxEvent.create({
      data: {
        eventType: 'SECURITY_ALERT_DETECTED',
        aggregateId: randomUUID(),
        dedupeKey: `${prefix}:${randomUUID()}`,
        payload: {
          securityAlertId: randomUUID(),
          repositoryFullName: 'integration-test/repository',
          alertNumber: 123,
        },
        ...overrides,
      },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    service = new OutboxService(prisma, queueMock as never);
  });

  beforeEach(async () => {
    prefix = `outbox-integration:${randomUUID()}`;
    await prisma.outboxEvent.deleteMany();

    jest.clearAllMocks();

    queueMock.add.mockResolvedValue({
      id: 'mock-job-id',
    });
  });

  afterEach(async () => {
    await prisma.outboxEvent.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should recover and publish an event with an expired lease', async () => {
    const event = await createEvent({
      lockToken: 'expired-token',
      lockedUntil: new Date(Date.now() - 60_000),
    });

    const result = await service.dispatchPending();

    const storedEvent = await prisma.outboxEvent.findUnique({
      where: { id: event.id },
    });

    expect(queueMock.add).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      skipped: false,
      processed: 1,
      published: 1,
      failed: 0,
      leaseLost: 0,
    });

    expect(storedEvent?.status).toBe(OutboxStatus.PUBLISHED);
    expect(storedEvent?.lockToken).toBeNull();
    expect(storedEvent?.lockedUntil).toBeNull();
    expect(storedEvent?.publishedAt).toBeInstanceOf(Date);
  });

  it('should skip rows locked by another transaction', async () => {
    const firstEvent = await createEvent({
      createdAt: new Date(Date.now() - 10_000),
    });

    const secondEvent = await createEvent();

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM outbox_events
        WHERE id = ${firstEvent.id}::uuid
        FOR UPDATE
      `;

      return service.dispatchPending();
    });

    expect(queueMock.add).toHaveBeenCalledTimes(1);

    expect(queueMock.add).toHaveBeenCalledWith(
      'analyze-security-alert',
      expect.objectContaining({
        eventId: secondEvent.id,
      }),
      expect.objectContaining({
        jobId: secondEvent.id,
      }),
    );

    const storedFirstEvent = await prisma.outboxEvent.findUnique({
      where: { id: firstEvent.id },
    });

    const storedSecondEvent = await prisma.outboxEvent.findUnique({
      where: { id: secondEvent.id },
    });

    expect(storedFirstEvent?.status).toBe(OutboxStatus.PENDING);
    expect(storedFirstEvent?.lockToken).toBeNull();

    expect(storedSecondEvent?.status).toBe(OutboxStatus.PUBLISHED);

    expect(result).toEqual({
      skipped: false,
      processed: 1,
      published: 1,
      failed: 0,
      leaseLost: 0,
    });
  });

  it('should not update an event after its lease token changes', async () => {
    const event = await createEvent();

    queueMock.add.mockImplementationOnce(async () => {
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          lockToken: 'new-owner-token',
          lockedUntil: new Date(Date.now() + 60_000),
        },
      });

      return { id: event.id };
    });

    const result = await service.dispatchPending();

    const storedEvent = await prisma.outboxEvent.findUnique({
      where: { id: event.id },
    });

    expect(queueMock.add).toHaveBeenCalledTimes(1);

    expect(storedEvent?.status).toBe(OutboxStatus.PENDING);
    expect(storedEvent?.lockToken).toBe('new-owner-token');

    expect(result).toEqual({
      skipped: false,
      processed: 1,
      published: 0,
      failed: 0,
      leaseLost: 1,
    });
  });

  it('should propagate a database confirmation failure after Redis accepts the job', async () => {
    const event = await createEvent();

    const updateManySpy = jest
      .spyOn(prisma.outboxEvent, 'updateMany')
      .mockRejectedValueOnce(new Error('PostgreSQL confirmation failed'));

    await expect(service.dispatchPending()).rejects.toThrow(
      'PostgreSQL confirmation failed',
    );

    expect(queueMock.add).toHaveBeenCalledTimes(1);

    updateManySpy.mockRestore();

    // The event remains pending with its lease.
    // Another dispatcher can recover it after expiration.
    const storedEvent = await prisma.outboxEvent.findUnique({
      where: { id: event.id },
    });

    expect(storedEvent?.status).toBe(OutboxStatus.PENDING);
    expect(storedEvent?.lockToken).not.toBeNull();
    expect(storedEvent?.lockedUntil).not.toBeNull();
  });
});
