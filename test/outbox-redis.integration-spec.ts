import { OutboxStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/database/prisma.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { OutboxScheduler } from '../src/outbox/outbox.scheduler';

describe('OutboxScheduler (Redis integration)', () => {
  let prisma: PrismaService;
  let queue: Queue;
  let scheduler: OutboxScheduler;
  let eventId: string | undefined;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    queue = new Queue('security-analysis', {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
      },
    });

    await queue.waitUntilReady();

    const outboxService = new OutboxService(prisma, queue);
    scheduler = new OutboxScheduler(outboxService);
  });

  afterEach(async () => {
    if (eventId) {
      const job = await queue.getJob(eventId);

      if (job) {
        await job.remove();
      }

      await prisma.outboxEvent.deleteMany({
        where: { id: eventId },
      });

      eventId = undefined;
    }
  });

  afterAll(async () => {
    await queue.close();
    await prisma.$disconnect();
  });

  it('should publish a PostgreSQL event to the real Redis queue', async () => {
    const event = await prisma.outboxEvent.create({
      data: {
        eventType: 'SECURITY_ALERT_DETECTED',
        aggregateId: randomUUID(),
        dedupeKey: `redis-integration:${randomUUID()}`,
        payload: {
          securityAlertId: randomUUID(),
          repositoryFullName: 'integration-test/repository',
          alertNumber: 456,
        },
      },
    });

    eventId = event.id;

    // Execute the same method invoked by the scheduled interval.
    await scheduler.dispatchOutboxEvents();

    // Verify PostgreSQL confirmation.
    const storedEvent = await prisma.outboxEvent.findUnique({
      where: { id: event.id },
    });

    expect(storedEvent?.status).toBe(OutboxStatus.PUBLISHED);
    expect(storedEvent?.publishedAt).toBeInstanceOf(Date);
    expect(storedEvent?.lockToken).toBeNull();

    // Verify the real BullMQ job exists in Redis.
    const job = await queue.getJob(event.id);

    expect(job).toBeDefined();
    expect(job?.name).toBe('analyze-security-alert');
    expect(job?.data).toEqual(
      expect.objectContaining({
        eventId: event.id,
        eventType: 'SECURITY_ALERT_DETECTED',
        repositoryFullName: 'integration-test/repository',
        alertNumber: 456,
      }),
    );

    // Execute again: PUBLISHED events must not be dispatched again.
    await scheduler.dispatchOutboxEvents();

    const jobs = await queue.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);

    const matchingJobs = jobs.filter(
      (existingJob) => existingJob.id === event.id,
    );

    expect(matchingJobs).toHaveLength(1);
  });
});
