import { SecurityAnalysisResultSchema } from './security-analysis-result.schema';

describe('SecurityAnalysisResultSchema', () => {
  const validResult = {
    riskLevel: 'HIGH',
    exploitability: 'PROOF_OF_CONCEPT',
    confidence: 0.95,
    summary: 'A vulnerable dependency was detected.',
    impact: 'An attacker may execute arbitrary code.',
    remediation: {
      strategy: 'UPGRADE',
      targetVersion: '2.5.0',
      rationale: 'The target version fixes the vulnerability.',
      steps: ['Update the dependency.', 'Run the test suite.'],
    },
    compatibility: {
      breakingChangeRisk: 'LOW',
      notes: ['No breaking changes identified.'],
    },
    evidence: [
      {
        source: 'GITHUB_ADVISORY',
        reference: 'GHSA-example',
        finding: 'The advisory identifies the affected version.',
      },
    ],
    requiresHumanReview: false,
    humanReviewReason: null,
  };

  it('should accept a valid analysis result', () => {
    const result = SecurityAnalysisResultSchema.safeParse(validResult);

    expect(result.success).toBe(true);
  });

  it('should reject an invalid risk level', () => {
    const result = SecurityAnalysisResultSchema.safeParse({
      ...validResult,
      riskLevel: 'URGENT',
    });

    expect(result.success).toBe(false);
  });

  it('should reject confidence outside the valid range', () => {
    const result = SecurityAnalysisResultSchema.safeParse({
      ...validResult,
      confidence: 1.5,
    });

    expect(result.success).toBe(false);
  });

  it('should reject missing remediation information', () => {
    const result = SecurityAnalysisResultSchema.safeParse({
      ...validResult,
      remediation: {
        strategy: 'UPGRADE',
      },
    });

    expect(result.success).toBe(false);
  });

  it('should reject unexpected properties', () => {
    const result = SecurityAnalysisResultSchema.safeParse({
      ...validResult,
      unexpectedField: 'not allowed',
    });

    expect(result.success).toBe(false);
  });
});
