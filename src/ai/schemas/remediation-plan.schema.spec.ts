import { RemediationPlanSchema } from './remediation-plan.schema';

describe('RemediationPlanSchema', () => {
  const validPlan = {
    summary: 'Upgrade vulnerable dependency.',
    riskLevel: 'HIGH',

    dependencyUpdates: [
      {
        packageName: 'example-package',
        currentVersion: '1.0.0',
        targetVersion: '2.0.0',
        packageManager: 'pnpm',
        dependencyType: 'PRODUCTION',
        rationale: 'Version 2.0.0 fixes the vulnerability.',
      },
    ],

    fileChanges: [
      {
        path: 'src/config.ts',
        operation: 'MODIFY',
        instructions: 'Update the deprecated API usage.',
        rationale: 'Maintain compatibility with the new version.',
      },
    ],

    validationChecks: [
      'INSTALL',
      'TYPECHECK',
      'TEST',
      'BUILD',
      'DEPENDENCY_AUDIT',
    ],

    successCriteria: [
      'The vulnerable dependency is upgraded.',
      'All tests pass.',
      'No new vulnerabilities are introduced.',
    ],

    pullRequest: {
      title: 'fix: upgrade vulnerable dependency',
      description: 'Automated security remediation.',
    },
  };

  it('should accept a valid remediation plan', () => {
    const result = RemediationPlanSchema.safeParse(validPlan);

    expect(result.success).toBe(true);
  });

  it('should reject an invalid package manager', () => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      dependencyUpdates: [
        {
          ...validPlan.dependencyUpdates[0],
          packageManager: 'unknown',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('should reject paths outside the workspace', () => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      fileChanges: [
        {
          ...validPlan.fileChanges[0],
          path: '../../.env',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('should reject absolute paths', () => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      fileChanges: [
        {
          ...validPlan.fileChanges[0],
          path: '/etc/passwd',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('should reject plans without validation checks', () => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      validationChecks: [],
    });

    expect(result.success).toBe(false);
  });

  it('should reject duplicate validation checks', () => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      validationChecks: ['TEST', 'TEST'],
    });

    expect(result.success).toBe(false);
  });

  it('should reject unexpected properties', () => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      executeArbitraryCommand: 'rm -rf /',
    });

    expect(result.success).toBe(false);
  });

  it.each([
    '../../etc/passwd',
    '/etc/passwd',
    'C:/Windows/system32/config',
    'C:\\Windows\\system32\\config',
    './src/config.ts',
    'src/../config.ts',
    'src//config.ts',
    '.env',
    '.env.production',
    'config/.npmrc',
    'config/credentials',
    'config/secrets.json',
    'id_rsa',
    'keys/id_ed25519',
  ])('should reject unsafe workspace path: %s', (path) => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      fileChanges: [
        {
          ...validPlan.fileChanges[0],
          path,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it.each([
    'src/config.ts',
    'packages/api/src/service.ts',
    'test/security/remediation.spec.ts',
  ])('should accept safe relative workspace path: %s', (path) => {
    const result = RemediationPlanSchema.safeParse({
      ...validPlan,
      fileChanges: [
        {
          ...validPlan.fileChanges[0],
          path,
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
