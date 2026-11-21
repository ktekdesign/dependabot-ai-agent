import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DockerWorkspaceExecutor } from './docker-workspace.executor';
import { loadRemediationConfig } from '../config/remediation.config';
import { WorkspaceService } from './workspace.service';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

describe('DockerWorkspaceExecutor', () => {
  let executor: DockerWorkspaceExecutor;
  let workspaceService: WorkspaceService;
  let config: ReturnType<typeof loadRemediationConfig>;
  let root: string;
  let workspacePath: string;
  let analysisId: string;

  const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

  beforeEach(async () => {
    jest.clearAllMocks();

    root = await mkdtemp(join(tmpdir(), 'docker-executor-test-'));
    analysisId = randomUUID();

    config = loadRemediationConfig({
      REMEDIATION_WORKSPACE_ROOT: join(root, 'workspaces'),
    });

    workspaceService = new WorkspaceService(config);

    const workspace = await workspaceService.createWorkspace(analysisId);
    workspacePath = workspace.path;

    executor = new DockerWorkspaceExecutor(config, workspaceService);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  function createMockProcess(cleanupExitCode = 0) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: jest.Mock;
    };

    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn().mockReturnValue(true);

    mockedSpawn.mockImplementation((_command, args) => {
      const dockerArgs = args as string[];

      if (dockerArgs[0] === 'run') {
        return child as never;
      }

      const controlProcess = new EventEmitter() as EventEmitter & {
        kill: jest.Mock;
      };

      controlProcess.kill = jest.fn().mockReturnValue(true);

      setImmediate(() => {
        controlProcess.emit(
          'close',
          dockerArgs[0] === 'rm' ? cleanupExitCode : 0,
          null,
        );

        if (dockerArgs[0] === 'kill') {
          child.emit('close', 137, null);
        }
      });

      return controlProcess as never;
    });

    return child;
  }

  async function waitForSpawn(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (mockedSpawn.mock.calls.length > 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('Docker spawn was not called');
  }

  it('runs an authorized command inside an isolated container', async () => {
    const child = createMockProcess();

    const execution = executor.execute(workspacePath, analysisId, 'BUILD');

    await waitForSpawn();

    const dockerArgs = mockedSpawn.mock.calls[0][1] as string[];

    expect(dockerArgs).toContain('--network');
    expect(dockerArgs).toContain('none');
    expect(dockerArgs).toContain('--read-only');
    expect(dockerArgs).toContain('--cap-drop');
    expect(dockerArgs).toContain('ALL');
    expect(dockerArgs).toContain('--pids-limit');
    expect(dockerArgs).toContain('128');
    expect(dockerArgs).toContain('--cpus');
    expect(dockerArgs).toContain('1');
    expect(dockerArgs).toContain('1g');
    expect(dockerArgs).toContain('npm');

    expect(mockedSpawn.mock.calls[0][0]).toBe('docker');

    expect(mockedSpawn.mock.calls[0][2]).toMatchObject({
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.end('build output');
    child.stderr.end('');
    child.emit('close', 0, null);

    await expect(execution).resolves.toMatchObject({
      command: 'BUILD',
      exitCode: 0,
      stdout: 'build output',
      stderr: '',
      timedOut: false,
      cancelled: false,
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(2);

    expect(mockedSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['rm', '-f']),
    );
  });

  it('preserves non-zero exit codes and stderr', async () => {
    const child = createMockProcess();

    const execution = executor.execute(workspacePath, analysisId, 'TEST');

    await waitForSpawn();

    child.stdout.end('');
    child.stderr.end('tests failed');
    child.emit('close', 1, null);

    await expect(execution).resolves.toMatchObject({
      command: 'TEST',
      exitCode: 1,
      stderr: 'tests failed',
      timedOut: false,
      cancelled: false,
    });
  });

  it('rejects invalid analysis IDs without starting Docker', async () => {
    await expect(
      executor.execute(workspacePath, 'invalid-id', 'BUILD'),
    ).rejects.toThrow('Invalid analysis ID');

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rejects a workspace outside the configured root', async () => {
    const outsideWorkspace = join(root, analysisId);
    await mkdir(outsideWorkspace);

    await expect(
      executor.execute(outsideWorkspace, analysisId, 'BUILD'),
    ).rejects.toThrow('Workspace must be a direct child');

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rejects unsupported commands without starting Docker', async () => {
    await expect(
      executor.execute(workspacePath, analysisId, 'SHELL' as never),
    ).rejects.toThrow('Unsupported workspace command');

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rejects a symbolic link as workspace', async () => {
    const { symlink } = await import('node:fs/promises');

    const linkId = randomUUID();
    const linkPath = join(root, 'workspaces', linkId);

    await symlink(workspacePath, linkPath);

    await expect(executor.execute(linkPath, linkId, 'BUILD')).rejects.toThrow(
      'Workspace must be a real directory',
    );

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('rejects Docker startup failures and attempts cleanup', async () => {
    const child = createMockProcess();

    const execution = executor.execute(workspacePath, analysisId, 'BUILD');

    await waitForSpawn();

    child.emit('error', new Error('Docker is unavailable'));

    await expect(execution).rejects.toThrow('Docker is unavailable');

    expect(mockedSpawn).toHaveBeenCalledTimes(2);

    expect(mockedSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['rm', '-f']),
    );
  });

  it('rejects execution when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute(workspacePath, analysisId, 'BUILD', {
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled before startup');

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('terminates the container when execution is cancelled', async () => {
    const child = createMockProcess();
    const controller = new AbortController();

    const execution = executor.execute(workspacePath, analysisId, 'BUILD', {
      signal: controller.signal,
    });

    await waitForSpawn();

    controller.abort();

    const result = await execution;

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(137);

    expect(mockedSpawn).toHaveBeenCalledTimes(3);

    expect(mockedSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['kill']),
    );

    expect(mockedSpawn.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['rm', '-f']),
    );

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('terminates the container when execution times out', async () => {
    createMockProcess();

    executor = new DockerWorkspaceExecutor(
      loadRemediationConfig({
        REMEDIATION_WORKSPACE_ROOT: join(root, 'workspaces'),
        REMEDIATION_EXECUTION_TIMEOUT_MS: '50',
      }),
      workspaceService,
    );
    const execution = executor.execute(workspacePath, analysisId, 'BUILD');

    await waitForSpawn();

    const result = await execution;

    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.exitCode).toBe(137);

    expect(mockedSpawn).toHaveBeenCalledTimes(3);

    expect(mockedSpawn.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['kill']),
    );

    expect(mockedSpawn.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['rm', '-f']),
    );
  });

  it('rejects when container cleanup fails', async () => {
    const child = createMockProcess(1);

    const execution = executor.execute(workspacePath, analysisId, 'BUILD');

    await waitForSpawn();

    child.emit('close', 0, null);

    await expect(execution).rejects.toThrow('Container cleanup failed');
  });

  it('preserves execution and cleanup errors together', async () => {
    const child = createMockProcess(1);

    const execution = executor.execute(workspacePath, analysisId, 'BUILD');

    await waitForSpawn();

    child.emit('error', new Error('Docker is unavailable'));

    await expect(execution).rejects.toThrow('Docker execution failed');
  });

  it('waits for Docker control process termination after timeout', async () => {
    const mainProcess = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: jest.Mock;
    };

    mainProcess.stdout = new PassThrough();
    mainProcess.stderr = new PassThrough();
    mainProcess.kill = jest.fn().mockReturnValue(true);

    const killProcess = new EventEmitter() as EventEmitter & {
      kill: jest.Mock;
    };

    killProcess.kill = jest.fn().mockReturnValue(true);

    const cleanupProcess = new EventEmitter();

    mockedSpawn.mockImplementation((_command, args) => {
      const dockerArgs = args as string[];

      if (dockerArgs[0] === 'run') {
        return mainProcess as never;
      }

      if (dockerArgs[0] === 'kill') {
        return killProcess as never;
      }

      if (dockerArgs[0] === 'rm') {
        setImmediate(() => cleanupProcess.emit('close', 0, null));
        return cleanupProcess as never;
      }

      throw new Error(`Unexpected Docker command: ${dockerArgs[0]}`);
    });

    executor = new DockerWorkspaceExecutor(
      loadRemediationConfig({
        REMEDIATION_WORKSPACE_ROOT: join(root, 'workspaces'),
        REMEDIATION_EXECUTION_TIMEOUT_MS: '50',
        REMEDIATION_DOCKER_CONTROL_TIMEOUT_MS: '100',
      }),
      workspaceService,
    );

    const execution = executor.execute(workspacePath, analysisId, 'BUILD');

    await waitForSpawn();

    for (let attempt = 0; attempt < 50; attempt++) {
      if (mockedSpawn.mock.calls.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(mockedSpawn).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(killProcess.kill).toHaveBeenCalledWith('SIGKILL');

    // The control process must close before termination continues.
    killProcess.emit('close', null, 'SIGKILL');

    // Allow the rejected control-process promise to propagate.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mainProcess.kill).toHaveBeenCalledWith('SIGTERM');

    mainProcess.emit('close', null, 'SIGTERM');

    await expect(execution).resolves.toMatchObject({
      timedOut: true,
      cancelled: false,
    });

    expect(mockedSpawn.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['rm', '-f']),
    );
  });

  it('detects a Docker control process that does not close after SIGKILL', async () => {
    const mainProcess = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: jest.Mock;
    };

    mainProcess.stdout = new PassThrough();
    mainProcess.stderr = new PassThrough();
    mainProcess.kill = jest.fn().mockReturnValue(true);

    const killProcess = new EventEmitter() as EventEmitter & {
      kill: jest.Mock;
    };

    killProcess.kill = jest.fn().mockReturnValue(true);

    const cleanupProcess = new EventEmitter();

    mockedSpawn.mockImplementation((_command, args) => {
      const dockerArgs = args as string[];

      if (dockerArgs[0] === 'run') return mainProcess as never;
      if (dockerArgs[0] === 'kill') return killProcess as never;

      if (dockerArgs[0] === 'rm') {
        setImmediate(() => cleanupProcess.emit('close', 0, null));
        return cleanupProcess as never;
      }

      throw new Error(`Unexpected Docker command: ${dockerArgs[0]}`);
    });

    executor = new DockerWorkspaceExecutor(
      loadRemediationConfig({
        REMEDIATION_EXECUTION_TIMEOUT_MS: '50',
        REMEDIATION_DOCKER_CONTROL_TIMEOUT_MS: '100',
      }),
      workspaceService,
    );

    const execution = executor.execute(workspacePath, analysisId, 'BUILD');

    await waitForSpawn();

    for (let attempt = 0; attempt < 50; attempt++) {
      if (mockedSpawn.mock.calls.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(mockedSpawn).toHaveBeenCalledTimes(2);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(killProcess.kill).toHaveBeenCalledWith('SIGKILL');

    // Intentionally do not emit the control process close event.
    await new Promise((resolve) => setTimeout(resolve, 5_100));

    expect(mainProcess.kill).toHaveBeenCalledWith('SIGTERM');

    mainProcess.emit('close', null, 'SIGTERM');

    await expect(execution).resolves.toMatchObject({
      timedOut: true,
      cancelled: false,
    });

    expect(mockedSpawn.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['rm', '-f']),
    );
  }, 15000);
});
