import 'dotenv/config';

import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../src/database/prisma.service';
import { AnalysisService } from '../src/analysis/analysis.service';
import { AnalysisProcessor } from '../src/analysis/analysis.processor';
import { LangGraphCheckpointerService } from '../src/workflows/checkpointer/langgraph-checkpointer.service';
import { createSecurityAnalysisGraph } from '../src/workflows/security-analysis/security-analysis.graph';
import { AnalysisRecoveryScheduler } from '../src/analysis/analysis-recovery.scheduler';
import { AIService } from '../src/ai/ai.service';
import { QueueService } from '../src/queue/queue.service';

describe('AnalysisProcessor (integration)', () => {
  let prisma: PrismaService;
  let analysisService: AnalysisService;
  let processor: AnalysisProcessor;

  let queue: Queue;
  let worker: Worker;
  let queueEvents: QueueEvents;

  let repositoryId: string;
  let alertId: string;
  let eventId: string;

  // Keep the Jest mock type so mockClear() is available.
  let aiService: jest.Mocked<
    Pick<AIService, 'analyzeSecurity' | 'createRemediationPlan'>
  >;

  const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
  };

  const checkpointerService = new LangGraphCheckpointerService();

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    analysisService = new AnalysisService(prisma);
    await checkpointerService.onModuleInit();

    aiService = {
      analyzeSecurity: jest.fn().mockResolvedValue({
        riskLevel: 'HIGH',
        exploitability: 'PROOF_OF_CONCEPT',
        confidence: 0.95,
        summary: 'A vulnerability was detected.',
        impact: 'An attacker may exploit the dependency.',
        remediation: {
          strategy: 'UPGRADE',
          targetVersion: '4.17.21',
          rationale: 'The patched version fixes the vulnerability.',
          steps: ['Upgrade lodash to 4.17.21.'],
        },
        compatibility: {
          breakingChangeRisk: 'LOW',
          notes: ['No breaking changes identified.'],
        },
        evidence: [],
        requiresHumanReview: false,
        humanReviewReason: null,
      }),
      createRemediationPlan: jest.fn().mockResolvedValue({
        summary: 'Upgrade lodash to the patched version.',
        riskLevel: 'HIGH',
        dependencyUpdates: [],
        fileChanges: [],
        validationChecks: [
          'INSTALL',
          'TEST',
          'DEPENDENCY_AUDIT',
          'LINT',
          'TYPECHECK',
          'BUILD',
        ],
        successCriteria: ['All required validation checks pass.'],
        pullRequest: {
          title: 'fix: upgrade lodash vulnerability',
          description: 'Upgrade lodash to version 4.17.21.',
        },
      }),
    } as jest.Mocked<
      Pick<AIService, 'analyzeSecurity' | 'createRemediationPlan'>
    >;

    processor = new AnalysisProcessor(
      analysisService,
      checkpointerService,
      aiService as unknown as AIService,
    );

    queue = new Queue('security-analysis', { connection });

    queueEvents = new QueueEvents('security-analysis', {
      connection,
    });

    worker = new Worker(
      'security-analysis',
      async (job: Job<{ eventId: string }>) => {
        await processor.process(job);
      },
      { connection, concurrency: 5 },
    );

    await queue.waitUntilReady();
    await queueEvents.waitUntilReady();
    await worker.waitUntilReady();
  });

  beforeEach(async () => {
    aiService.analyzeSecurity.mockClear();
    aiService.createRemediationPlan.mockClear();

    const suffix = randomUUID();

    const repository = await prisma.repository.create({
      data: {
        githubId:
          BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
        owner: 'integration-test',
        name: suffix,
        fullName: `integration-test/${suffix}`,
        monitoringStatus: 'ENABLED',
      },
    });

    repositoryId = repository.id;

    const alert = await prisma.securityAlert.create({
      data: {
        repositoryId,
        alertNumber: 1,
        packageName: 'lodash',
        ecosystem: 'npm',
        severity: 'high',
        cveId: 'CVE-TEST-001',
        vulnerableVersion: '< 4.17.21',
        patchedVersion: '4.17.21',
        manifestPath: 'package-lock.json',
        state: 'OPEN',
      },
    });

    alertId = alert.id;

    const event = await prisma.outboxEvent.create({
      data: {
        eventType: 'SECURITY_ALERT_DETECTED',
        aggregateId: alert.id,
        dedupeKey: `integration:${randomUUID()}`,
        payload: {
          schemaVersion: 1,
          securityAlertId: alert.id,
          repositoryFullName: repository.fullName,
          alertNumber: 1,
          fingerprint: randomUUID(),
          alertSnapshot: {
            number: 1,
            packageName: 'lodash',
            ecosystem: 'npm',
            severity: 'high',
            cveId: 'CVE-TEST-001',
            vulnerableVersion: '< 4.17.21',
            patchedVersion: '4.17.21',
            manifestPath: 'package-lock.json',
            state: 'OPEN',
            firstDetectedAt: null,
            lastUpdatedAt: null,
          },
        },
      },
    });

    eventId = event.id;
  });

  afterEach(async () => {
    await prisma.outboxEvent.deleteMany({
      where: { id: eventId },
    });

    await prisma.securityAlert.deleteMany({
      where: { id: alertId },
    });

    await prisma.repository.deleteMany({
      where: { id: repositoryId },
    });
  });

  afterAll(async () => {
    await worker.close();
    await queueEvents.close();
    await queue.close();
    await checkpointerService.onModuleDestroy();
    await prisma.$disconnect();
  });

  it('should acquire a pending analysis exactly once', async () => {
    const registered = await analysisService.registerPendingAnalysis(eventId);

    const first = await analysisService.acquireAnalysis(registered.analysis.id);

    const second = await analysisService.acquireAnalysis(
      registered.analysis.id,
    );

    expect(first.acquired).toBe(true);

    if (!first.acquired) {
      throw new Error('First acquisition should succeed');
    }

    expect(first.reason).toBe('ACQUIRED');
    expect(first.processingToken).toBeDefined();

    expect(second).toEqual({
      acquired: false,
      reason: 'ALREADY_PROCESSING',
    });

    const persisted = await prisma.securityAnalysis.findUnique({
      where: { id: registered.analysis.id },
    });

    expect(persisted?.status).toBe('PROCESSING');
    expect(persisted?.processingToken).toBe(first.processingToken);
    expect(persisted?.attempts).toBe(1);
  });

  it('should allow only one worker to acquire an analysis concurrently', async () => {
    const registered = await analysisService.registerPendingAnalysis(eventId);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        analysisService.acquireAnalysis(registered.analysis.id),
      ),
    );

    const successful = results.filter((result) => result.acquired);

    expect(successful).toHaveLength(1);

    const persisted = await prisma.securityAnalysis.findUnique({
      where: { id: registered.analysis.id },
    });

    expect(persisted?.status).toBe('PROCESSING');
    expect(persisted?.attempts).toBe(1);
  });

  it('should allow acquisition after the processing lease expires', async () => {
    const registered = await analysisService.registerPendingAnalysis(eventId);

    const first = await analysisService.acquireAnalysis(registered.analysis.id);

    expect(first.acquired).toBe(true);

    await prisma.securityAnalysis.update({
      where: { id: registered.analysis.id },
      data: {
        processingLeaseUntil: new Date(Date.now() - 1000),
      },
    });

    const second = await analysisService.acquireAnalysis(
      registered.analysis.id,
    );

    expect(second.acquired).toBe(true);

    if (!first.acquired || !second.acquired) {
      throw new Error('Both acquisitions should succeed sequentially');
    }

    expect(second.processingToken).not.toBe(first.processingToken);

    const persisted = await prisma.securityAnalysis.findUnique({
      where: { id: registered.analysis.id },
    });

    expect(persisted?.attempts).toBe(2);
    expect(persisted?.processingToken).toBe(second.processingToken);
  });

  it('should recover an expired analysis through the recovery scheduler', async () => {
    const registered = await analysisService.registerPendingAnalysis(eventId);

    const firstAcquisition = await analysisService.acquireAnalysis(
      registered.analysis.id,
    );

    if (!firstAcquisition.acquired) {
      throw new Error('Initial acquisition should succeed');
    }

    // Simulate a worker that persisted its LangGraph checkpoint
    // but died before completing the database record.
    const graph = createSecurityAnalysisGraph(
      checkpointerService.getCheckpointer(),
    );

    await graph.invoke(registered.workflowInput, {
      configurable: {
        thread_id: registered.analysis.id,
      },
    });

    const expiredLease = new Date(Date.now() - 1000);

    await prisma.securityAnalysis.update({
      where: { id: registered.analysis.id },
      data: {
        processingLeaseUntil: expiredLease,
      },
    });

    const scheduler = new AnalysisRecoveryScheduler(
      analysisService,
      new QueueService(queue),
    );

    await scheduler.recoverExpiredAnalyses();

    const recoveryJobId = `recovery-${registered.analysis.id}-${expiredLease.getTime()}`;

    const recoveryJob = await queue.getJob(recoveryJobId);

    expect(recoveryJob).not.toBeNull();

    if (!recoveryJob) {
      throw new Error('Recovery job was not published');
    }

    await recoveryJob.waitUntilFinished(queueEvents, 15000);

    const recovered = await prisma.securityAnalysis.findUnique({
      where: { id: registered.analysis.id },
    });

    expect(recovered?.status).toBe('COMPLETED');
    expect(recovered?.attempts).toBe(2);
    expect(recovered?.processingToken).toBeNull();
    expect(recovered?.processingLeaseUntil).toBeNull();

    const checkpoint = await graph.getState({
      configurable: {
        thread_id: registered.analysis.id,
      },
    });

    expect(checkpoint.values.eventId).toBe(eventId);
    expect(checkpoint.values.securityAlertId).toBe(alertId);
  });

  it('should consume a job and persist its analysis in PostgreSQL', async () => {
    const job = await queue.add(
      'analyze-security-alert',
      { eventId },
      {
        jobId: randomUUID(),
        attempts: 1,
        removeOnComplete: true,
      },
    );

    await job.waitUntilFinished(queueEvents, 15000);

    const analysis = await prisma.securityAnalysis.findUnique({
      where: { outboxEventId: eventId },
    });

    expect(analysis).not.toBeNull();
    expect(analysis?.securityAlertId).toBe(alertId);
    expect(analysis?.status).toBe('COMPLETED');

    expect(analysis?.alertSnapshot).toMatchObject({
      number: 1,
      packageName: 'lodash',
      severity: 'high',
    });
  });

  it('should not create duplicate analyses when the same event is delivered twice', async () => {
    const firstJob = await queue.add(
      'analyze-security-alert',
      { eventId },
      {
        jobId: randomUUID(),
        attempts: 1,
        removeOnComplete: true,
      },
    );

    await firstJob.waitUntilFinished(queueEvents, 15000);

    const secondJob = await queue.add(
      'analyze-security-alert',
      { eventId },
      {
        jobId: randomUUID(),
        attempts: 1,
        removeOnComplete: true,
      },
    );

    await secondJob.waitUntilFinished(queueEvents, 15000);

    const analyses = await prisma.securityAnalysis.findMany({
      where: { outboxEventId: eventId },
    });

    expect(analyses).toHaveLength(1);
    expect(analyses[0].status).toBe('COMPLETED');
  });

  it('should prevent duplicate analyses when the same event is processed concurrently', async () => {
    const jobs = await Promise.all(
      Array.from({ length: 5 }, () =>
        queue.add(
          'analyze-security-alert',
          { eventId },
          {
            jobId: randomUUID(),
            attempts: 1,
            removeOnComplete: true,
          },
        ),
      ),
    );

    await Promise.all(
      jobs.map((job) => job.waitUntilFinished(queueEvents, 15000)),
    );

    const analyses = await prisma.securityAnalysis.findMany({
      where: { outboxEventId: eventId },
    });

    expect(analyses).toHaveLength(1);
    expect(analyses[0].status).toBe('COMPLETED');
  });

  it('should retry a failed job and persist the analysis successfully', async () => {
    const originalRegister =
      analysisService.registerPendingAnalysis.bind(analysisService);

    const registerSpy = jest
      .spyOn(analysisService, 'registerPendingAnalysis')
      .mockRejectedValueOnce(new Error('Transient database failure'))
      .mockImplementation(originalRegister);

    const job = await queue.add(
      'analyze-security-alert',
      { eventId },
      {
        jobId: randomUUID(),
        attempts: 2,
        backoff: {
          type: 'fixed',
          delay: 100,
        },
        removeOnComplete: true,
      },
    );

    await job.waitUntilFinished(queueEvents, 15000);

    expect(registerSpy).toHaveBeenCalledTimes(2);

    const analysis = await prisma.securityAnalysis.findUnique({
      where: { outboxEventId: eventId },
    });

    expect(analysis).not.toBeNull();
    expect(analysis?.status).toBe('COMPLETED');

    registerSpy.mockRestore();
  });

  it('should recover workflow state from PostgreSQL using the same thread_id', async () => {
    const job = await queue.add(
      'analyze-security-alert',
      { eventId },
      {
        jobId: randomUUID(),
        attempts: 1,
        removeOnComplete: true,
      },
    );

    await job.waitUntilFinished(queueEvents, 15000);

    const analysis = await prisma.securityAnalysis.findUnique({
      where: { outboxEventId: eventId },
    });

    expect(analysis).not.toBeNull();

    if (!analysis) {
      throw new Error('Security analysis was not persisted');
    }

    const config = {
      configurable: {
        thread_id: analysis.id,
      },
    };

    const recoveredGraph = createSecurityAnalysisGraph(
      checkpointerService.getCheckpointer(),
      aiService as unknown as AIService,
    );

    // Consulta o checkpoint sem fornecer uma nova entrada ao workflow.
    await recoveredGraph.invoke(null, config);

    const checkpoint = await recoveredGraph.getState(config);

    expect(checkpoint.values.eventId).toBe(eventId);
    expect(checkpoint.values.securityAlertId).toBe(alertId);
    expect(checkpoint.values.repositoryFullName).toContain('integration-test/');
    expect(checkpoint.values.alertNumber).toBe(1);
    expect(checkpoint.values.preparedContext).toContain('lodash');
    expect(checkpoint.values.preparedContext).toContain('CVE-TEST-001');

    expect(checkpoint.values.securityAnalysisResult).toMatchObject({
      riskLevel: 'HIGH',
      summary: 'A vulnerability was detected.',
      remediation: {
        targetVersion: '4.17.21',
      },
    });

    expect(aiService.analyzeSecurity).toHaveBeenCalledTimes(1);
    expect(aiService.createRemediationPlan).toHaveBeenCalledTimes(1);
  });

  it('should recover workflow state after checkpointer reconnection', async () => {
    const job = await queue.add(
      'analyze-security-alert',
      { eventId },
      {
        jobId: randomUUID(),
        attempts: 1,
        removeOnComplete: true,
      },
    );

    await job.waitUntilFinished(queueEvents, 15000);

    const analysis = await prisma.securityAnalysis.findUnique({
      where: { outboxEventId: eventId },
    });

    if (!analysis) {
      throw new Error('Security analysis was not persisted');
    }

    const config = {
      configurable: {
        thread_id: analysis.id,
      },
    };

    await checkpointerService.onModuleDestroy();
    await checkpointerService.onModuleInit();

    const recoveredGraph = createSecurityAnalysisGraph(
      checkpointerService.getCheckpointer(),
      aiService as unknown as AIService,
    );

    // Consulta o checkpoint sem fornecer uma nova entrada ao workflow.
    await recoveredGraph.invoke(null, config);

    const checkpoint = await recoveredGraph.getState(config);

    expect(checkpoint.values.eventId).toBe(eventId);
    expect(checkpoint.values.securityAlertId).toBe(alertId);
    expect(checkpoint.values.preparedContext).toContain('lodash');
    expect(checkpoint.values.preparedContext).toContain('CVE-TEST-001');

    expect(checkpoint.values.securityAnalysisResult).toMatchObject({
      riskLevel: 'HIGH',
      summary: 'A vulnerability was detected.',
      remediation: {
        targetVersion: '4.17.21',
      },
    });

    expect(aiService.analyzeSecurity).toHaveBeenCalledTimes(1);
    expect(aiService.createRemediationPlan).toHaveBeenCalledTimes(1);
  });
});
