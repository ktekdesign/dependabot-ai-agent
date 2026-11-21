import { AIService } from '../../ai/ai.service';
import { SecurityAnalysisStateType } from './security-analysis.state';

type ValidationInput = Pick<
  SecurityAnalysisStateType,
  | 'eventId'
  | 'securityAlertId'
  | 'repositoryFullName'
  | 'alertNumber'
  | 'fingerprint'
  | 'alertSnapshot'
>;

type AnalysisPreparationInput = Pick<
  SecurityAnalysisStateType,
  'repositoryFullName' | 'alertNumber' | 'alertSnapshot'
>;

type AnalyzeSecurityInput = Pick<
  SecurityAnalysisStateType,
  'preparedContext' | 'alertSnapshot'
>;

type CreateRemediationPlanInput = Pick<
  SecurityAnalysisStateType,
  'preparedContext' | 'alertSnapshot' | 'securityAnalysisResult'
>;

export async function validateInputNode(
  state: ValidationInput,
): Promise<Partial<SecurityAnalysisStateType>> {
  if (!state.eventId) {
    throw new Error('Missing eventId');
  }

  if (!state.securityAlertId) {
    throw new Error('Missing securityAlertId');
  }

  if (!state.repositoryFullName) {
    throw new Error('Missing repositoryFullName');
  }

  if (!Number.isInteger(state.alertNumber) || state.alertNumber <= 0) {
    throw new Error('Invalid alertNumber');
  }

  if (!state.fingerprint) {
    throw new Error('Missing fingerprint');
  }

  if (
    !state.alertSnapshot ||
    typeof state.alertSnapshot !== 'object' ||
    Array.isArray(state.alertSnapshot)
  ) {
    throw new Error('Invalid alertSnapshot');
  }

  return {};
}

export async function prepareAnalysisNode(
  state: AnalysisPreparationInput,
): Promise<Partial<SecurityAnalysisStateType>> {
  const alert = state.alertSnapshot;

  const preparedContext = [
    `Repository: ${state.repositoryFullName}`,
    `Alert number: ${state.alertNumber}`,
    `Package: ${String(alert.packageName ?? 'Unknown')}`,
    `Ecosystem: ${String(alert.ecosystem ?? 'Unknown')}`,
    `Severity: ${String(alert.severity ?? 'Unknown')}`,
    `CVE: ${String(alert.cveId ?? 'Not provided')}`,
    `Vulnerable version: ${String(alert.vulnerableVersion ?? 'Unknown')}`,
    `Patched version: ${String(alert.patchedVersion ?? 'Not provided')}`,
    `Manifest: ${String(alert.manifestPath ?? 'Unknown')}`,
  ].join('\n');

  return { preparedContext };
}

export function createAnalyzeSecurityNode(aiService: AIService) {
  return async function analyzeSecurityNode(
    state: AnalyzeSecurityInput,
  ): Promise<Partial<SecurityAnalysisStateType>> {
    if (!state.preparedContext) {
      throw new Error('Missing preparedContext');
    }

    const result = await aiService.analyzeSecurity({
      messages: [
        {
          role: 'user',
          content: [
            'Analyze this Dependabot security alert.',
            'Assess its actual security impact and recommend a safe remediation.',
            'Do not assume that a patched version is compatible without evidence.',
            '',
            'Alert context:',
            state.preparedContext,
            '',
            'Complete alert snapshot:',
            JSON.stringify(state.alertSnapshot),
          ].join('\n'),
        },
      ],
    });

    return {
      securityAnalysisResult: result,
    };
  };
}

export function createRemediationPlanNode(aiService: AIService) {
  return async function remediationPlanNode(
    state: CreateRemediationPlanInput,
  ): Promise<Partial<SecurityAnalysisStateType>> {
    if (!state.preparedContext) {
      throw new Error('Missing preparedContext');
    }

    if (!state.securityAnalysisResult) {
      throw new Error('Missing securityAnalysisResult');
    }

    const analysis = state.securityAnalysisResult;

    const result = await aiService.createRemediationPlan(
      {
        messages: [
          {
            role: 'user',
            content: [
              'Create an actionable remediation plan for this security vulnerability.',
              'The plan must be consistent with the supplied security analysis.',
              'Do not invent package versions or compatibility evidence.',
              'Use only the supplied repository context.',
              'List every required file change and validation check.',
              '',
              'Repository and alert context:',
              state.preparedContext,
              '',
              'Complete alert snapshot:',
              JSON.stringify(state.alertSnapshot),
              '',
              'Security analysis:',
              JSON.stringify(analysis),
            ].join('\n'),
          },
        ],
      },
      analysis.riskLevel,
    );

    return {
      remediationPlan: result,
    };
  };
}
