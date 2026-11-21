import { z } from 'zod';

const isSafeWorkspacePath = (value: string): boolean => {
  const path = value.trim();

  if (
    !path ||
    path.startsWith('/') ||
    path.startsWith('~') ||
    path.includes('\\') ||
    /^[a-zA-Z]:/.test(path) ||
    /[\u0000-\u001F\u007F]/.test(path)
  ) {
    return false;
  }

  const segments = path.split('/');

  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return false;
  }

  const restrictedSegment =
    /^(\.env($|\.)|\.npmrc$|\.pypirc$|\.netrc$|id_rsa($|\.)|id_ed25519($|\.)|credentials?($|\.)|secrets?($|\.))/i;
  return !segments.some((segment) => restrictedSegment.test(segment));
};

const safeWorkspacePath = z
  .string()
  .trim()
  .min(1)
  .refine(isSafeWorkspacePath, 'Invalid or restricted workspace path');

export const RemediationPlanSchema = z
  .object({
    summary: z.string().trim().min(1),
    riskLevel: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),

    dependencyUpdates: z.array(
      z
        .object({
          packageName: z.string().trim().min(1),
          currentVersion: z.string().trim().min(1),
          targetVersion: z.string().trim().min(1),
          packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun']),
          dependencyType: z.enum([
            'PRODUCTION',
            'DEVELOPMENT',
            'PEER',
            'OPTIONAL',
          ]),
          rationale: z.string().trim().min(1),
        })
        .strict(),
    ),

    fileChanges: z.array(
      z
        .object({
          path: safeWorkspacePath,
          operation: z.enum(['CREATE', 'MODIFY']),
          instructions: z.string().trim().min(1),
          rationale: z.string().trim().min(1),
        })
        .strict(),
    ),

    validationChecks: z
      .array(
        z.enum([
          'INSTALL',
          'LINT',
          'TYPECHECK',
          'TEST',
          'BUILD',
          'DEPENDENCY_AUDIT',
        ]),
      )
      .min(1)
      .refine(
        (checks) => new Set(checks).size === checks.length,
        'Validation checks must be unique',
      ),

    successCriteria: z.array(z.string().trim().min(1)).min(1),

    pullRequest: z
      .object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;
