import { createSecurityAnalysisGraph } from './security-analysis.graph';

import { AIService } from '../../ai/ai.service';

import { SecurityAnalysisResult } from '../../ai/schemas/security-analysis-result.schema';
import { RemediationPlan } from '../../ai/schemas/remediation-plan.schema';

describe('SecurityAnalysisGraph', () => {
  const graph = createSecurityAnalysisGraph();

  const validInput = {
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
  };

  it('should execute the complete graph', async () => {
    const result = await graph.invoke(validInput);

    expect(result.eventId).toBe('event-123');
    expect(result.preparedContext).toContain('lodash');
    expect(result.preparedContext).toContain('CVE-2021-23337');
  });

  it('should reject an invalid event', async () => {
    await expect(
      graph.invoke({
        ...validInput,
        eventId: '',
      }),
    ).rejects.toThrow('Missing eventId');
  });

  it('should reject an invalid alert number', async () => {
    await expect(
      graph.invoke({
        ...validInput,
        alertNumber: 0,
      }),
    ).rejects.toThrow('Invalid alertNumber');
  });

  it('should execute the complete graph with AI analysis and remediation plan', async () => {
    const analysisResult: SecurityAnalysisResult = {
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
    };

    const remediationPlan = {
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
    } as RemediationPlan;

    const aiService = {
      analyzeSecurity: jest.fn().mockResolvedValue(analysisResult),
      createRemediationPlan: jest.fn().mockResolvedValue(remediationPlan),
    };

    const graphWithAI = createSecurityAnalysisGraph(
      undefined,
      aiService as unknown as AIService,
    );

    const result = await graphWithAI.invoke(validInput);

    expect(aiService.analyzeSecurity).toHaveBeenCalledTimes(1);
    expect(aiService.createRemediationPlan).toHaveBeenCalledTimes(1);

    expect(aiService.createRemediationPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.any(Array),
      }),
      'HIGH',
    );

    expect(result.preparedContext).toContain('lodash');
    expect(result.securityAnalysisResult).toEqual(analysisResult);
    expect(result.remediationPlan).toEqual(remediationPlan);
  });
});
