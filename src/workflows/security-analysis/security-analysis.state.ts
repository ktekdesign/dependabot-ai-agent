import { Annotation } from '@langchain/langgraph';

import { SecurityAnalysisResult } from '../../ai/schemas/security-analysis-result.schema';
import { RemediationPlan } from '../../ai/schemas/remediation-plan.schema';

export const SecurityAnalysisState = Annotation.Root({
  eventId: Annotation<string>(),
  securityAlertId: Annotation<string>(),
  repositoryFullName: Annotation<string>(),
  alertNumber: Annotation<number>(),
  fingerprint: Annotation<string>(),
  alertSnapshot: Annotation<Record<string, unknown>>(),
  preparedContext: Annotation<string>(),
  securityAnalysisResult: Annotation<SecurityAnalysisResult>(),
  remediationPlan: Annotation<RemediationPlan>(),
});

export type SecurityAnalysisStateType = typeof SecurityAnalysisState.State;
