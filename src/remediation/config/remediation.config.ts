import { z } from 'zod';

const positiveInteger = z.coerce.number().int().positive();

const environmentSchema = z.object({
  REMEDIATION_WORKSPACE_ROOT: z.string().trim().min(1).optional(),

  REMEDIATION_DOCKER_IMAGE: z
    .string()
    .trim()
    .min(1)
    .default('dependabot-remediation-node:22'),

  REMEDIATION_EXECUTION_TIMEOUT_MS: positiveInteger
    .max(30 * 60 * 1000)
    .default(10 * 60 * 1000),

  REMEDIATION_DOCKER_CONTROL_TIMEOUT_MS: positiveInteger
    .max(60 * 1000)
    .default(15 * 1000),

  REMEDIATION_MAX_OUTPUT_LENGTH: positiveInteger
    .max(1024 * 1024)
    .default(64 * 1024),

  REMEDIATION_MEMORY: z.string().trim().min(1).default('1g'),

  REMEDIATION_MEMORY_SWAP: z.string().trim().min(1).default('1g'),

  REMEDIATION_CPUS: z.coerce.number().positive().max(8).default(1),

  REMEDIATION_PIDS_LIMIT: positiveInteger.max(1024).default(128),

  REMEDIATION_TMP_SIZE_MB: positiveInteger.max(1024).default(128),
});

export interface RemediationConfig {
  workspaceRoot?: string;
  docker: {
    image: string;
    executionTimeoutMs: number;
    controlTimeoutMs: number;
    maxOutputLength: number;
    memory: string;
    memorySwap: string;
    cpus: number;
    pidsLimit: number;
    tmpSizeMb: number;
  };
}

export function loadRemediationConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RemediationConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(
      `Invalid remediation configuration: ${z.prettifyError(parsed.error)}`,
    );
  }

  const values = parsed.data;

  return {
    workspaceRoot: values.REMEDIATION_WORKSPACE_ROOT,
    docker: {
      image: values.REMEDIATION_DOCKER_IMAGE,
      executionTimeoutMs: values.REMEDIATION_EXECUTION_TIMEOUT_MS,
      controlTimeoutMs: values.REMEDIATION_DOCKER_CONTROL_TIMEOUT_MS,
      maxOutputLength: values.REMEDIATION_MAX_OUTPUT_LENGTH,
      memory: values.REMEDIATION_MEMORY,
      memorySwap: values.REMEDIATION_MEMORY_SWAP,
      cpus: values.REMEDIATION_CPUS,
      pidsLimit: values.REMEDIATION_PIDS_LIMIT,
      tmpSizeMb: values.REMEDIATION_TMP_SIZE_MB,
    },
  };
}
