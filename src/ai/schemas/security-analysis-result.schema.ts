import { z } from 'zod';

export const SecurityAnalysisResultSchema = z
  .object({
    riskLevel: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),

    exploitability: z.enum([
      'KNOWN_EXPLOITED',
      'PROOF_OF_CONCEPT',
      'THEORETICAL',
      'UNKNOWN',
    ]),

    confidence: z.number().min(0).max(1),

    summary: z.string().trim().min(1),

    impact: z.string().trim().min(1),

    remediation: z
      .object({
        strategy: z.enum([
          'UPGRADE',
          'REPLACE',
          'REMOVE',
          'MITIGATE',
          'MANUAL_REVIEW',
        ]),
        targetVersion: z.string().trim().min(1).nullable(),
        rationale: z.string().trim().min(1),
        steps: z.array(z.string().trim().min(1)),
      })
      .strict(),

    compatibility: z
      .object({
        breakingChangeRisk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']),
        notes: z.array(z.string().trim().min(1)),
      })
      .strict(),

    evidence: z.array(
      z
        .object({
          source: z.enum([
            'GITHUB_ADVISORY',
            'CVE',
            'PACKAGE_METADATA',
            'REPOSITORY_CONTEXT',
            'OTHER',
          ]),
          reference: z.string().trim().min(1),
          finding: z.string().trim().min(1),
        })
        .strict(),
    ),

    requiresHumanReview: z.boolean(),

    humanReviewReason: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SecurityAnalysisResult = z.infer<
  typeof SecurityAnalysisResultSchema
>;
