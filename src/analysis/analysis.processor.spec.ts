import { AnalysisProcessor } from './analysis.processor';
import { AnalysisService } from './analysis.service';
import { LangGraphCheckpointerService } from '../workflows/checkpointer/langgraph-checkpointer.service';
import { Job } from 'bullmq';
import { AIService } from '../ai/ai.service';
import * as SecurityAnalysisGraph from '../workflows/security-analysis/security-analysis.graph';

describe('AnalysisProcessor', () => {
  let processor: AnalysisProcessor;

  const analysisService = {
    registerPendingAnalysis: jest.fn(),
    acquireAnalysis: jest.fn(),
    completeAnalysis: jest.fn(),
    failAnalysis: jest.fn(),
    renewAnalysisLease: jest.fn(),
  };

  const graph = {
    invoke: jest.fn(),
  };

  const checkpointerService = {
    getCheckpointer: jest.fn().mockReturnValue({}),
  };

  let aiService: {
    analyzeSecurity: jest.Mock;
    createRemediationPlan: jest.Mock;
  };

  const createJob = (eventId = 'event-uuid') =>
    ({
      data: { eventId },
    }) as Job<{ eventId: string }>;

  beforeEach(() => {
    jest.clearAllMocks();

    analysisService.registerPendingAnalysis.mockResolvedValue({
      analysis: {
        id: 'analysis-uuid',
        status: 'PENDING',
      },
      workflowInput: {
        eventId: 'event-uuid',
        securityAlertId: 'alert-uuid',
        repositoryFullName: 'integration-test/repository',
        alertNumber: 42,
        fingerprint: 'test-fingerprint',
        alertSnapshot: {
          packageName: 'lodash',
          severity: 'high',
        },
      },
    });

    analysisService.acquireAnalysis.mockResolvedValue({
      acquired: true,
      reason: 'ACQUIRED',
      analysisId: 'analysis-uuid',
      processingToken: 'processing-token',
    });

    analysisService.completeAnalysis.mockResolvedValue(true);
    analysisService.failAnalysis.mockResolvedValue(true);
    analysisService.renewAnalysisLease.mockResolvedValue(true);

    checkpointerService.getCheckpointer.mockReturnValue({});
    graph.invoke.mockResolvedValue({ result: 'analysis-result' });
    aiService = {
      analyzeSecurity: jest.fn(),
      createRemediationPlan: jest.fn(),
    };
    jest
      .spyOn(SecurityAnalysisGraph, 'createSecurityAnalysisGraph')
      .mockReturnValue(graph as never);

    processor = new AnalysisProcessor(
      analysisService as unknown as AnalysisService,
      checkpointerService as unknown as LangGraphCheckpointerService,
      aiService as unknown as AIService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('executes the workflow with the analysis ID as thread_id', async () => {
    await processor.process(createJob());

    expect(analysisService.registerPendingAnalysis).toHaveBeenCalledWith(
      'event-uuid',
    );

    expect(analysisService.acquireAnalysis).toHaveBeenCalledWith(
      'analysis-uuid',
    );

    expect(checkpointerService.getCheckpointer).toHaveBeenCalled();

    expect(graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-uuid',
        securityAlertId: 'alert-uuid',
      }),
      {
        configurable: {
          thread_id: 'analysis-uuid',
        },
        signal: expect.any(AbortSignal),
      },
    );

    expect(analysisService.completeAnalysis).toHaveBeenCalledWith(
      'analysis-uuid',
      'processing-token',
      { result: 'analysis-result' },
    );

    expect(analysisService.failAnalysis).not.toHaveBeenCalled();
  });

  it('does not execute the workflow when another worker owns the lease', async () => {
    analysisService.acquireAnalysis.mockResolvedValue({
      acquired: false,
      reason: 'ALREADY_PROCESSING',
    });

    await processor.process(createJob());

    expect(graph.invoke).not.toHaveBeenCalled();
    expect(analysisService.completeAnalysis).not.toHaveBeenCalled();
    expect(analysisService.failAnalysis).not.toHaveBeenCalled();
  });

  it('rejects a job without eventId', async () => {
    await expect(
      processor.process({ data: {} } as Job<{ eventId: string }>),
    ).rejects.toThrow('Invalid security analysis job: missing eventId');

    expect(analysisService.registerPendingAnalysis).not.toHaveBeenCalled();
  });

  it('propagates registration errors to BullMQ', async () => {
    analysisService.registerPendingAnalysis.mockRejectedValue(
      new Error('Database unavailable'),
    );

    await expect(processor.process(createJob())).rejects.toThrow(
      'Database unavailable',
    );

    expect(analysisService.acquireAnalysis).not.toHaveBeenCalled();
  });

  it('propagates acquisition errors to BullMQ', async () => {
    analysisService.acquireAnalysis.mockRejectedValue(
      new Error('Database unavailable'),
    );

    await expect(processor.process(createJob())).rejects.toThrow(
      'Database unavailable',
    );

    expect(graph.invoke).not.toHaveBeenCalled();
  });

  it('marks the analysis as failed and propagates workflow errors', async () => {
    const workflowError = new Error('Workflow failed');
    graph.invoke.mockRejectedValue(workflowError);

    await expect(processor.process(createJob())).rejects.toThrow(
      'Workflow failed',
    );

    expect(analysisService.failAnalysis).toHaveBeenCalledWith(
      'analysis-uuid',
      'processing-token',
      workflowError,
    );

    expect(analysisService.completeAnalysis).not.toHaveBeenCalled();
  });

  it('throws when the processing lease is lost before completion', async () => {
    analysisService.completeAnalysis.mockResolvedValue(false);

    await expect(processor.process(createJob())).rejects.toThrow(
      'lost its processing lease before completion',
    );

    expect(analysisService.failAnalysis).toHaveBeenCalledWith(
      'analysis-uuid',
      'processing-token',
      expect.any(Error),
    );
  });

  it('does not hide the original error if failure persistence also fails', async () => {
    const workflowError = new Error('Workflow failed');
    graph.invoke.mockRejectedValue(workflowError);

    analysisService.failAnalysis.mockRejectedValue(
      new Error('Database unavailable'),
    );

    await expect(processor.process(createJob())).rejects.toThrow(
      'Workflow failed',
    );
  });

  it('aborts the workflow when lease renewal fails', async () => {
    jest.useFakeTimers();

    analysisService.renewAnalysisLease.mockResolvedValue(false);

    graph.invoke.mockImplementation(
      (_input: unknown, config: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          config.signal.addEventListener(
            'abort',
            () => reject(config.signal.reason),
            { once: true },
          );
        }),
    );

    const processPromise = processor.process(createJob());

    const rejectionAssertion = expect(processPromise).rejects.toThrow(
      'lost its processing lease during heartbeat',
    );

    await jest.advanceTimersByTimeAsync(60_000);

    await rejectionAssertion;

    expect(analysisService.renewAnalysisLease).toHaveBeenCalledWith(
      'analysis-uuid',
      'processing-token',
    );

    expect(analysisService.completeAnalysis).not.toHaveBeenCalled();

    expect(analysisService.failAnalysis).toHaveBeenCalled();
  });
});
