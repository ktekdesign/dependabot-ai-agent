import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AnalysisService } from './analysis.service';
import { LangGraphCheckpointerService } from '../workflows/checkpointer/langgraph-checkpointer.service';
import { createSecurityAnalysisGraph } from '../workflows/security-analysis/security-analysis.graph';
import { AIService } from '../ai/ai.service';

interface SecurityAnalysisJob {
  eventId: string;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

@Processor('security-analysis')
export class AnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalysisProcessor.name);

  constructor(
    private readonly analysisService: AnalysisService,
    private readonly checkpointerService: LangGraphCheckpointerService,
    private readonly aiService: AIService,
  ) {
    super();
  }

  async process(job: Job<SecurityAnalysisJob>): Promise<void> {
    const eventId = job.data?.eventId;

    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new Error('Invalid security analysis job: missing eventId');
    }

    const registered =
      await this.analysisService.registerPendingAnalysis(eventId);

    const acquisition = await this.analysisService.acquireAnalysis(
      registered.analysis.id,
    );

    if (!acquisition.acquired) {
      this.logger.log(
        `Analysis ${registered.analysis.id} not acquired: ${acquisition.reason}`,
      );
      return;
    }

    const { analysisId, processingToken } = acquisition;

    const abortController = new AbortController();

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTask: Promise<void> | undefined;
    let leaseLostError: Error | undefined;

    const stopHeartbeat = async (): Promise<void> => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      await heartbeatTask;
    };

    try {
      const graph = createSecurityAnalysisGraph(
        this.checkpointerService.getCheckpointer(),
        this.aiService,
      );

      heartbeatTimer = setInterval(() => {
        if (heartbeatTask || leaseLostError) {
          return;
        }

        heartbeatTask = (async () => {
          try {
            const renewed = await this.analysisService.renewAnalysisLease(
              analysisId,
              processingToken,
            );

            if (!renewed) {
              throw new Error(
                `Analysis ${analysisId} lost its processing lease during heartbeat`,
              );
            }

            this.logger.debug(`Analysis lease renewed: ${analysisId}`);
          } catch (error) {
            leaseLostError =
              error instanceof Error ? error : new Error(String(error));

            this.logger.error(
              `Analysis heartbeat failed: ${analysisId}`,
              leaseLostError.stack,
            );

            abortController.abort(leaseLostError);
          }
        })().finally(() => {
          heartbeatTask = undefined;
        });
      }, HEARTBEAT_INTERVAL_MS);

      const result = await graph.invoke(registered.workflowInput, {
        configurable: {
          thread_id: analysisId,
        },
        signal: abortController.signal,
      });

      await stopHeartbeat();

      if (leaseLostError) {
        throw leaseLostError;
      }

      const completed = await this.analysisService.completeAnalysis(
        analysisId,
        processingToken,
        result,
      );

      if (!completed) {
        throw new Error(
          `Analysis ${analysisId} lost its processing lease before completion`,
        );
      }

      this.logger.log(`Security analysis completed: ${analysisId}`);
    } catch (error) {
      await stopHeartbeat();

      const processingError = leaseLostError ?? error;

      try {
        const markedAsFailed = await this.analysisService.failAnalysis(
          analysisId,
          processingToken,
          processingError,
        );

        if (!markedAsFailed) {
          this.logger.warn(
            `Could not mark analysis ${analysisId} as FAILED: processing lease was lost`,
          );
        }
      } catch (persistenceError) {
        this.logger.error(
          `Could not persist failure for analysis ${analysisId}`,
          persistenceError instanceof Error
            ? persistenceError.stack
            : String(persistenceError),
        );
      }

      throw processingError;
    } finally {
      await stopHeartbeat();
    }
  }
}
