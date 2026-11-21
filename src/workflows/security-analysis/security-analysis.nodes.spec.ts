import { AIService } from '../../ai/ai.service';
import { SecurityAnalysisResult } from '../../ai/schemas/security-analysis-result.schema';
import {
  createAnalyzeSecurityNode,
  prepareAnalysisNode,
} from './security-analysis.nodes';

describe('SecurityAnalysisNodes', () => {
  const validState = {
    eventId: 'event-123',
    securityAlertId: 'alert-123',
    repositoryFullName: 'organization/project',
    alertNumber: 42,
    fingerprint: 'fingerprint-123',
    alertSnapshot: {
      packageName: 'lodash',
      ecosystem: 'npm',
      severity: 'high',
      cveId: 'CVE-2021-23337',
      vulnerableVersion: '<4.17.21',
      patchedVersion: '4.17.21',
      manifestPath: 'package-lock.json',
    },
    preparedContext: 'Repository: organization/project',
  };

  const analysisResult: SecurityAnalysisResult = {
    riskLevel: 'HIGH',
    exploitability: 'PROOF_OF_CONCEPT',
    confidence: 0.95,
    summary: 'A vulnerability was detected.',
    impact: 'An attacker may exploit the dependency.',
    remediation: {
      strategy: 'UPGRADE',
      targetVersion: '4.17.21',
      rationale: 'The upgrade fixes the vulnerability.',
      steps: ['Upgrade lodash.'],
    },
    compatibility: {
      breakingChangeRisk: 'LOW',
      notes: ['No breaking changes identified.'],
    },
    evidence: [],
    requiresHumanReview: false,
    humanReviewReason: null,
  };

  it('should prepare the analysis context', async () => {
    const result = await prepareAnalysisNode(validState);

    expect(result.preparedContext).toContain('lodash');
    expect(result.preparedContext).toContain('CVE-2021-23337');
  });

  it('should analyze the vulnerability using AIService', async () => {
    const aiService = {
      analyzeSecurity: jest.fn().mockResolvedValue(analysisResult),
    };

    const node = createAnalyzeSecurityNode(aiService as unknown as AIService);

    const result = await node(validState);

    expect(aiService.analyzeSecurity).toHaveBeenCalledTimes(1);
    expect(aiService.analyzeSecurity).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('CVE-2021-23337'),
          }),
        ]),
      }),
    );

    expect(result.securityAnalysisResult).toEqual(analysisResult);
  });

  it('should reject when preparedContext is missing', async () => {
    const aiService = {
      analyzeSecurity: jest.fn(),
    };

    const node = createAnalyzeSecurityNode(aiService as unknown as AIService);

    await expect(
      node({
        ...validState,
        preparedContext: '',
      }),
    ).rejects.toThrow('Missing preparedContext');

    expect(aiService.analyzeSecurity).not.toHaveBeenCalled();
  });

  it('should propagate AI provider errors', async () => {
    const aiService = {
      analyzeSecurity: jest
        .fn()
        .mockRejectedValue(new Error('AI provider unavailable')),
    };

    const node = createAnalyzeSecurityNode(aiService as unknown as AIService);

    await expect(node(validState)).rejects.toThrow('AI provider unavailable');
  });
});
