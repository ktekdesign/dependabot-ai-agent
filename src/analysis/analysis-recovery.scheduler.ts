import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AnalysisService } from './analysis.service';
import { QueueService } from '../queue/queue.service';

const RECOVERY_INTERVAL_MS = Math.max(
  5000,
  Number.parseInt(process.env.ANALYSIS_RECOVERY_INTERVAL_MS ?? '15000', 10) ||
    15000,
);

const RECOVERY_BATCH_SIZE = 50;

@Injectable()
export class AnalysisRecoveryScheduler {
  private readonly logger = new Logger(AnalysisRecoveryScheduler.name);
  private isRunning = false;

  constructor(
    private readonly analysisService: AnalysisService,
    private readonly queueService: QueueService,
  ) {}

  @Interval(RECOVERY_INTERVAL_MS)
  async recoverExpiredAnalyses(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const analyses =
        await this.analysisService.findExpiredProcessingAnalyses(
          RECOVERY_BATCH_SIZE,
        );

      let enqueued = 0;
      let failed = 0;

      for (const analysis of analyses) {
        if (!analysis.processingLeaseUntil) {
          continue;
        }

        try {
          await this.queueService.enqueueAnalysisRecovery(
            analysis.id,
            analysis.outboxEventId,
            analysis.processingLeaseUntil,
          );

          enqueued++;
        } catch (error) {
          failed++;

          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.error(
            `Failed to enqueue recovery for analysis ${analysis.id}: ${message}`,
          );
        }
      }

      if (analyses.length > 0) {
        this.logger.log(
          `Analysis recovery completed: found=${analyses.length}, enqueued=${enqueued}, failed=${failed}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`Analysis recovery failed: ${message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
