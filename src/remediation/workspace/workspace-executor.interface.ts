export const WORKSPACE_EXECUTOR = Symbol('WORKSPACE_EXECUTOR');

export type WorkspaceCommand = 'TEST' | 'BUILD' | 'TYPECHECK' | 'LINT';

export interface WorkspaceExecutionResult {
  command: WorkspaceCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export interface WorkspaceExecutionOptions {
  signal?: AbortSignal;
}

export interface WorkspaceExecutor {
  execute(
    workspacePath: string,
    analysisId: string,
    command: WorkspaceCommand,
    options?: WorkspaceExecutionOptions,
  ): Promise<WorkspaceExecutionResult>;
}
