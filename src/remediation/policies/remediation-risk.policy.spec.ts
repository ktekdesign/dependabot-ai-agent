import { applyRemediationRiskPolicy } from './remediation-risk.policy';
import type { RemediationPlan } from '../../ai/schemas/remediation-plan.schema';

describe('applyRemediationRiskPolicy', () => {
  const plan: RemediationPlan = {
    summary: 'Upgrade vulnerable dependency.',
    riskLevel: 'LOW',
    dependencyUpdates: [],
    fileChanges: [],
    validationChecks: ['INSTALL'],
    successCriteria: ['All tests pass.'],
    pullRequest: {
      title: 'fix: upgrade dependency',
      description: 'Automated security remediation.',
    },
  };

  it.each(['LOW', 'MEDIUM'] as const)(
    'should apply standard checks for %s',
    (riskLevel) => {
      const result = applyRemediationRiskPolicy(plan, riskLevel);

      expect(result.riskLevel).toBe(riskLevel);
      expect(result.validationChecks).toEqual(
        expect.arrayContaining(['INSTALL', 'TEST', 'DEPENDENCY_AUDIT']),
      );
      expect(result.validationChecks).not.toContain('BUILD');
    },
  );

  it.each(['HIGH', 'CRITICAL', 'UNKNOWN'] as const)(
    'should apply reinforced checks for %s',
    (riskLevel) => {
      const result = applyRemediationRiskPolicy(plan, riskLevel);

      expect(result.riskLevel).toBe(riskLevel);
      expect(result.validationChecks).toEqual(
        expect.arrayContaining([
          'INSTALL',
          'TEST',
          'DEPENDENCY_AUDIT',
          'LINT',
          'TYPECHECK',
          'BUILD',
        ]),
      );
    },
  );

  it('should override the risk level supplied by the plan', () => {
    const result = applyRemediationRiskPolicy(plan, 'CRITICAL');

    expect(result.riskLevel).toBe('CRITICAL');
  });

  it('should not duplicate validation checks', () => {
    const result = applyRemediationRiskPolicy(
      {
        ...plan,
        validationChecks: ['INSTALL', 'TEST'],
      },
      'HIGH',
    );

    expect(new Set(result.validationChecks).size).toBe(
      result.validationChecks.length,
    );
  });

  it('should not mutate the original plan', () => {
    const originalChecks = [...plan.validationChecks];

    applyRemediationRiskPolicy(plan, 'CRITICAL');

    expect(plan.validationChecks).toEqual(originalChecks);
    expect(plan.riskLevel).toBe('LOW');
  });
});
