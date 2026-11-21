import { AnalysisRecoveryScheduler } from './analysis-recovery.scheduler';
import { AnalysisService } from './analysis.service';
import { QueueService } from '../queue/queue.service';

describe('AnalysisRecoveryScheduler', () => {
  let scheduler: AnalysisRecoveryScheduler;

  let analysisService: {
    findExpiredProcessingAnalyses: jest.Mock;
  };

  let queueService: {
    enqueueAnalysisRecovery: jest.Mock;
  };

  const expiredAnalysis = {
    id: 'analysis-123',
    outboxEventId: 'event-123',
    processingLeaseUntil: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    analysisService = {
      findExpiredProcessingAnalyses: jest.fn(),
    };

    queueService = {
      enqueueAnalysisRecovery: jest.fn(),
    };

    scheduler = new AnalysisRecoveryScheduler(
      analysisService as unknown as AnalysisService,
      queueService as unknown as QueueService,
    );
  });

  it('should enqueue expired analyses', async () => {
    analysisService.findExpiredProcessingAnalyses.mockResolvedValue([
      expiredAnalysis,
    ]);

    queueService.enqueueAnalysisRecovery.mockResolvedValue(undefined);

    await scheduler.recoverExpiredAnalyses();

    expect(analysisService.findExpiredProcessingAnalyses).toHaveBeenCalledWith(
      50,
    );

    expect(queueService.enqueueAnalysisRecovery).toHaveBeenCalledWith(
      expiredAnalysis.id,
      expiredAnalysis.outboxEventId,
      expiredAnalysis.processingLeaseUntil,
    );
  });

  it('should not enqueue when there are no expired analyses', async () => {
    analysisService.findExpiredProcessingAnalyses.mockResolvedValue([]);

    await scheduler.recoverExpiredAnalyses();

    expect(queueService.enqueueAnalysisRecovery).not.toHaveBeenCalled();
  });

  it('should continue when one enqueue operation fails', async () => {
    const secondAnalysis = {
      ...expiredAnalysis,
      id: 'analysis-456',
      outboxEventId: 'event-456',
    };

    analysisService.findExpiredProcessingAnalyses.mockResolvedValue([
      expiredAnalysis,
      secondAnalysis,
    ]);

    queueService.enqueueAnalysisRecovery
      .mockRejectedValueOnce(new Error('Redis unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(scheduler.recoverExpiredAnalyses()).resolves.toBeUndefined();

    expect(queueService.enqueueAnalysisRecovery).toHaveBeenCalledTimes(2);
  });

  it('should prevent overlapping executions', async () => {
    let resolveSearch!: (value: unknown) => void;

    analysisService.findExpiredProcessingAnalyses.mockReturnValue(
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
    );

    const firstExecution = scheduler.recoverExpiredAnalyses();

    await scheduler.recoverExpiredAnalyses();

    expect(analysisService.findExpiredProcessingAnalyses).toHaveBeenCalledTimes(
      1,
    );

    resolveSearch([]);

    await firstExecution;
  });

  it('should recover after a database error', async () => {
    analysisService.findExpiredProcessingAnalyses
      .mockRejectedValueOnce(new Error('Database unavailable'))
      .mockResolvedValueOnce([]);

    await expect(scheduler.recoverExpiredAnalyses()).resolves.toBeUndefined();

    await expect(scheduler.recoverExpiredAnalyses()).resolves.toBeUndefined();

    expect(analysisService.findExpiredProcessingAnalyses).toHaveBeenCalledTimes(
      2,
    );
  });
});
