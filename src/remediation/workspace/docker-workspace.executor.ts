import { Inject, Injectable } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { REMEDIATION_CONFIG } from '../config/remediation-config.module';
import { WorkspaceService } from './workspace.service';

import type { RemediationConfig } from '../config/remediation.config';
import type {
  WorkspaceCommand,
  WorkspaceExecutionOptions,
  WorkspaceExecutionResult,
  WorkspaceExecutor,
} from './workspace-executor.interface';

export type {
  WorkspaceCommand,
  WorkspaceExecutionOptions,
  WorkspaceExecutionResult,
} from './workspace-executor.interface';

const COMMANDS: Record<WorkspaceCommand, string[]> = {
  TEST: ['npm', 'test', '--', '--runInBand'],
  BUILD: ['npm', 'run', 'build'],
  TYPECHECK: ['./node_modules/.bin/tsc', '--noEmit'],
  LINT: ['./node_modules/.bin/eslint', '.'],
};

@Injectable()
export class DockerWorkspaceExecutor implements WorkspaceExecutor {
  private readonly config: RemediationConfig['docker'];

  constructor(
    @Inject(REMEDIATION_CONFIG)
    config: RemediationConfig,
    private readonly workspaceService: WorkspaceService,
  ) {
    this.config = config.docker;
  }

  async execute(
    workspacePath: string,
    analysisId: string,
    command: WorkspaceCommand,
    options: WorkspaceExecutionOptions = {},
  ): Promise<WorkspaceExecutionResult> {
    const canonicalPath = await this.workspaceService.validateWorkspace(
      workspacePath,
      analysisId,
    );

    const commandArgs = COMMANDS[command];

    if (!commandArgs) {
      throw new Error('Unsupported workspace command');
    }

    if (options.signal?.aborted) {
      throw new Error('Workspace execution cancelled before startup');
    }

    const containerName = `dependabot-${randomUUID()}`;
    const startedAt = Date.now();

    const uid = process.getuid?.() ?? 10001;
    const gid = process.getgid?.() ?? 10001;

    const dockerArgs = [
      'run',
      '--init',
      '--name',
      containerName,

      '--network',
      'none',

      '--memory',
      this.config.memory,

      '--memory-swap',
      this.config.memorySwap,

      '--cpus',
      String(this.config.cpus),

      '--pids-limit',
      String(this.config.pidsLimit),

      '--read-only',
      '--tmpfs',
      `/tmp:rw,nosuid,nodev,noexec,size=${this.config.tmpSizeMb}m`,

      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',

      '--user',
      `${uid}:${gid}`,

      '--workdir',
      '/workspace',

      '--env',
      'HOME=/tmp',
      '--env',
      'npm_config_cache=/tmp/.npm',

      '--mount',
      `type=bind,source=${canonicalPath},target=/workspace`,

      this.config.image,
      ...commandArgs,
    ];

    return new Promise((resolveExecution, rejectExecution) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let mainProcessClosed = false;

      let terminationPromise: Promise<void> | undefined;
      let cleanupPromise: Promise<void> | undefined;

      let exitCode: number | null = null;
      let executionError: Error | undefined;

      let timeout: NodeJS.Timeout;

      const signal = options.signal;

      const appendOutput = (current: string, chunk: Buffer): string => {
        const text = chunk.toString();

        if (text.length >= this.config.maxOutputLength) {
          return text.slice(-this.config.maxOutputLength);
        }

        const combined = current + text;

        return combined.length > this.config.maxOutputLength
          ? combined.slice(-this.config.maxOutputLength)
          : combined;
      };

      const cleanupContainer = async (): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;

        cleanupPromise = this.runDockerControl(['rm', '-f', containerName]);

        return cleanupPromise;
      };

      const terminateContainer = async (): Promise<void> => {
        if (terminationPromise) return terminationPromise;

        terminationPromise = (async () => {
          try {
            await this.runDockerControl(['kill', containerName]);
          } catch {
            // The container may already have exited.
          }

          if (!mainProcessClosed) {
            child.kill('SIGTERM');
          }
        })();

        return terminationPromise;
      };

      const finalize = async (): Promise<void> => {
        if (settled || !mainProcessClosed) return;

        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);

        if (terminationPromise) {
          await terminationPromise;
        }

        let cleanupError: Error | undefined;

        try {
          await cleanupContainer();
        } catch (error) {
          cleanupError =
            error instanceof Error ? error : new Error(String(error));
        }

        if (executionError && cleanupError) {
          rejectExecution(
            new AggregateError(
              [executionError, cleanupError],
              `Docker execution failed: ${executionError.message}; ` +
                `container cleanup failed: ${cleanupError.message}`,
            ),
          );
          return;
        }

        if (executionError) {
          rejectExecution(executionError);
          return;
        }

        if (cleanupError) {
          rejectExecution(
            new Error(`Container cleanup failed: ${cleanupError.message}`),
          );
          return;
        }

        resolveExecution({
          command,
          exitCode,
          stdout,
          stderr,
          timedOut,
          cancelled,
          durationMs: Date.now() - startedAt,
        });
      };

      const onAbort = (): void => {
        if (settled || mainProcessClosed) return;

        cancelled = true;
        void terminateContainer();
      };

      const child = spawn('docker', dockerArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = appendOutput(stdout, chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = appendOutput(stderr, chunk);
      });

      child.on('error', (error: Error) => {
        executionError = error;
        mainProcessClosed = true;
        void finalize();
      });

      child.on('close', (code: number | null) => {
        exitCode = code;
        mainProcessClosed = true;
        void finalize();
      });

      signal?.addEventListener('abort', onAbort, { once: true });

      timeout = setTimeout(() => {
        if (settled || mainProcessClosed) return;

        timedOut = true;
        void terminateContainer();
      }, this.config.executionTimeoutMs);

      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  private runDockerControl(args: string[]): Promise<void> {
    return new Promise((resolveControl, rejectControl) => {
      let settled = false;
      let timedOut = false;

      const child: ChildProcess = spawn('docker', args, {
        shell: false,
        stdio: 'ignore',
      });

      let timeout: NodeJS.Timeout;
      let killTimeout: NodeJS.Timeout | undefined;

      const finish = (error?: Error): void => {
        if (settled) return;

        settled = true;
        clearTimeout(timeout);

        if (killTimeout) {
          clearTimeout(killTimeout);
        }

        if (error) {
          rejectControl(error);
        } else {
          resolveControl();
        }
      };

      timeout = setTimeout(() => {
        if (settled) return;

        timedOut = true;

        try {
          child.kill('SIGKILL');
        } catch {
          // The close event or kill grace timeout will settle the operation.
        }

        killTimeout = setTimeout(() => {
          finish(
            new Error(
              `Docker control process did not terminate after timeout: ${args[0]}`,
            ),
          );
        }, 5_000);
      }, this.config.controlTimeoutMs);

      child.once('error', (error: Error) => {
        finish(error);
      });

      child.once('close', (code: number | null) => {
        if (timedOut) {
          finish(new Error(`Docker control command timed out: ${args[0]}`));
          return;
        }

        if (code === 0) {
          finish();
        } else {
          finish(new Error(`Docker control command failed: ${args[0]}`));
        }
      });
    });
  }
}
