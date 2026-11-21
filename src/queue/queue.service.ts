import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('security-analysis')
    private readonly queue: Queue,
  ) {}

  async getQueueStatus() {
    return {
      waiting: await this.queue.getWaitingCount(),
      active: await this.queue.getActiveCount(),
      completed: await this.queue.getCompletedCount(),
      failed: await this.queue.getFailedCount(),
    };
  }

  async enqueueAnalysisRecovery(
    analysisId: string,
    eventId: string,
    leaseUntil: Date,
  ): Promise<void> {
    const jobId = `recovery-${analysisId}-${leaseUntil.getTime()}`;

    await this.queue.add(
      'analyze-security-alert',
      { eventId },
      {
        jobId,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 24 * 60 * 60,
          count: 10000,
        },
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 10000,
        },
      },
    );
  }
}
