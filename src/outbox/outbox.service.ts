import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { OutboxStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../database/prisma.service';

const BATCH_SIZE = 25;
const LEASE_DURATION_MS = 2 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

interface ClaimedEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  lockToken: string;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('security-analysis')
    private readonly queue: Queue,
  ) {}

  private async claimPendingEvents(): Promise<ClaimedEvent[]> {
    const lockToken = randomUUID();
    const lockedUntil = new Date(Date.now() + LEASE_DURATION_MS);

    return this.prisma.$transaction(async (tx) => {
      return tx.$queryRaw<ClaimedEvent[]>`
        WITH candidates AS (
          SELECT id
          FROM outbox_events
          WHERE status = 'PENDING'
            AND "availableAt" <= NOW()
            AND (
              "lockedUntil" IS NULL
              OR "lockedUntil" <= NOW()
            )
          ORDER BY "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${BATCH_SIZE}
        )
        UPDATE outbox_events AS events
        SET
          "lockToken" = ${lockToken},
          "lockedUntil" = ${lockedUntil},
          "updatedAt" = NOW()
        FROM candidates
        WHERE events.id = candidates.id
        RETURNING
          events.id,
          events."eventType",
          events.payload,
          events.attempts,
          events."lockToken"
      `;
    });
  }

  async dispatchPending() {
    const events = await this.claimPendingEvents();

    let published = 0;
    let failed = 0;
    let leaseLost = 0;

    for (const event of events) {
      try {
        await this.queue.add(
          'analyze-security-alert',
          {
            eventId: event.id,
            eventType: event.eventType,
            ...event.payload,
          },
          {
            jobId: event.id,
            attempts: 5,
            backoff: {
              type: 'exponential',
              delay: 5000,
            },
            removeOnComplete: {
              age: 7 * 24 * 60 * 60,
              count: 10000,
            },
            removeOnFail: false,
          },
        );
      } catch (error) {
        const attempts = event.attempts + 1;
        const delay = Math.min(5000 * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
        const message = error instanceof Error ? error.message : String(error);

        const result = await this.prisma.outboxEvent.updateMany({
          where: {
            id: event.id,
            lockToken: event.lockToken,
            status: OutboxStatus.PENDING,
          },
          data: {
            attempts,
            lastError: message.slice(0, 2000),
            availableAt: new Date(Date.now() + delay),
            lockToken: null,
            lockedUntil: null,
          },
        });

        if (result.count === 0) {
          leaseLost++;
          this.logger.warn(
            `Lease lost after publication failure for Outbox event ${event.id}`,
          );
          continue;
        }

        failed++;
        this.logger.error(
          `Failed to publish Outbox event ${event.id}: ${message}`,
        );

        continue;
      }

      // Redis accepted the job. Database confirmation is a separate operation.
      // If it fails, propagate the error and let the lease expire.
      const result = await this.prisma.outboxEvent.updateMany({
        where: {
          id: event.id,
          lockToken: event.lockToken,
          status: OutboxStatus.PENDING,
        },
        data: {
          status: OutboxStatus.PUBLISHED,
          publishedAt: new Date(),
          lastError: null,
          lockToken: null,
          lockedUntil: null,
        },
      });

      if (result.count === 0) {
        leaseLost++;
        this.logger.warn(
          `Lease lost after publishing Outbox event ${event.id}`,
        );
        continue;
      }

      published++;
    }

    return {
      skipped: false,
      processed: events.length,
      published,
      failed,
      leaseLost,
    };
  }
}
