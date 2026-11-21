import type { RemediationPlan } from '../../ai/schemas/remediation-plan.schema';
import type { SecurityAnalysisResult } from '../../ai/schemas/security-analysis-result.schema';

type RiskLevel = SecurityAnalysisResult['riskLevel'];

const BASE_VALIDATION_CHECKS = ['INSTALL', 'TEST', 'DEPENDENCY_AUDIT'] as const;

const REINFORCED_VALIDATION_CHECKS = [
  ...BASE_VALIDATION_CHECKS,
  'LINT',
  'TYPECHECK',
  'BUILD',
] as const;

export function applyRemediationRiskPolicy(
  plan: RemediationPlan,
  authoritativeRiskLevel: RiskLevel,
): RemediationPlan {
  const requiredChecks =
    authoritativeRiskLevel === 'HIGH' ||
    authoritativeRiskLevel === 'CRITICAL' ||
    authoritativeRiskLevel === 'UNKNOWN'
      ? REINFORCED_VALIDATION_CHECKS
      : BASE_VALIDATION_CHECKS;

  return {
    ...plan,
    riskLevel: authoritativeRiskLevel,
    validationChecks: [
      ...new Set([...plan.validationChecks, ...requiredChecks]),
    ],
  };
}
