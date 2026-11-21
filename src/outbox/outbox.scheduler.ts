import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';

const POLL_INTERVAL_MS = Math.max(
  1000,
  Number.parseInt(process.env.OUTBOX_POLL_INTERVAL_MS ?? '5000', 10) || 5000,
);

@Injectable()
export class OutboxScheduler {
  private readonly logger = new Logger(OutboxScheduler.name);
  private isRunning = false;

  constructor(private readonly outboxService: OutboxService) {}

  @Interval(POLL_INTERVAL_MS)
  async dispatchOutboxEvents(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const result = await this.outboxService.dispatchPending();

      if (result.processed > 0) {
        this.logger.log(`Outbox dispatch completed: ${JSON.stringify(result)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Outbox dispatch failed: ${message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
