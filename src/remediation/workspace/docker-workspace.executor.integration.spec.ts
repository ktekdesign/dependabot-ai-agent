import { DockerWorkspaceExecutor } from './docker-workspace.executor';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRemediationConfig } from '../config/remediation.config';
import { WorkspaceService } from './workspace.service';

const runIntegrationTest =
  process.env.RUN_DOCKER_INTEGRATION === 'true' ? it : it.skip;

describe('DockerWorkspaceExecutor integration', () => {
  let root: string;
  let workspacePath: string;
  let analysisId: string;
  let executor: DockerWorkspaceExecutor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dependabot-docker-integration-'));
    analysisId = randomUUID();

    const config = loadRemediationConfig({
      REMEDIATION_WORKSPACE_ROOT: root,
    });

    const workspaceService = new WorkspaceService(config);
    const workspace = await workspaceService.createWorkspace(analysisId);

    workspacePath = workspace.path;
    executor = new DockerWorkspaceExecutor(config, workspaceService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  runIntegrationTest(
    'executes Node.js inside Docker and writes to the workspace',
    async () => {
      await writeFile(
        join(workspacePath, 'package.json'),
        JSON.stringify({
          name: 'docker-executor-test',
          version: '1.0.0',
          scripts: {
            build:
              "node -e \"require('fs').writeFileSync('executor-result.txt', process.version)\"",
          },
        }),
      );

      const result = await executor.execute(workspacePath, analysisId, 'BUILD');

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);

      const runtimeVersion = await readFile(
        join(workspacePath, 'executor-result.txt'),
        'utf8',
      );

      expect(runtimeVersion).toBe('v22.23.5');
    },
    120_000,
  );

  runIntegrationTest(
    'enforces filesystem and network isolation',
    async () => {
      await writeFile(
        join(workspacePath, 'package.json'),
        JSON.stringify({
          name: 'docker-isolation-test',
          version: '1.0.0',
          scripts: {
            build: 'node isolation-check.cjs',
          },
        }),
      );

      await writeFile(
        join(workspacePath, 'isolation-check.cjs'),
        `
const fs = require('node:fs');
const net = require('node:net');

async function checkNetworkIsolation() {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: '1.1.1.1',
      port: 443,
    });

    let finished = false;

    const finish = (blocked) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(blocked);
    };

    socket.setTimeout(1500);
    socket.on('connect', () => finish(false));
    socket.on('error', () => finish(true));
    socket.on('timeout', () => finish(true));
  });
}

async function main() {
  let rootIsReadOnly = false;

  try {
    fs.writeFileSync(
      '/etc/dependabot-isolation-test-' + process.pid,
      'test',
    );
  } catch {
    rootIsReadOnly = true;
  }

  const tmpFile = '/tmp/dependabot-isolation-test-' + process.pid;

  fs.writeFileSync(tmpFile, 'temporary');
  const tmpIsWritable = fs.readFileSync(tmpFile, 'utf8') === 'temporary';
  fs.unlinkSync(tmpFile);

  const networkIsBlocked = await checkNetworkIsolation();

  const dockerSocketUnavailable =
    !fs.existsSync('/var/run/docker.sock');

  const result = {
    rootIsReadOnly,
    tmpIsWritable,
    networkIsBlocked,
    dockerSocketUnavailable,
  };

  fs.writeFileSync(
    '/workspace/isolation-result.json',
    JSON.stringify(result, null, 2),
  );

  if (Object.values(result).some((value) => value !== true)) {
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`,
      );

      const result = await executor.execute(workspacePath, analysisId, 'BUILD');

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);

      const isolationResult = JSON.parse(
        await readFile(join(workspacePath, 'isolation-result.json'), 'utf8'),
      );

      expect(isolationResult).toEqual({
        rootIsReadOnly: true,
        tmpIsWritable: true,
        networkIsBlocked: true,
        dockerSocketUnavailable: true,
      });
    },
    120_000,
  );

  runIntegrationTest(
    'terminates a real container after execution timeout',
    async () => {
      await writeFile(
        join(workspacePath, 'package.json'),
        JSON.stringify({
          name: 'docker-timeout-test',
          version: '1.0.0',
          scripts: {
            build: 'node -e "setInterval(() => {}, 1000)"',
          },
        }),
      );

      const config = loadRemediationConfig({
        REMEDIATION_WORKSPACE_ROOT: root,
        REMEDIATION_EXECUTION_TIMEOUT_MS: '2000',
      });

      const workspaceService = new WorkspaceService(config);

      executor = new DockerWorkspaceExecutor(config, workspaceService);

      const result = await executor.execute(workspacePath, analysisId, 'BUILD');

      expect(result.timedOut).toBe(true);
      expect(result.cancelled).toBe(false);
      expect(result.exitCode).not.toBe(0);
    },
    30_000,
  );

  runIntegrationTest(
    'terminates a real container when execution is cancelled',
    async () => {
      await writeFile(
        join(workspacePath, 'package.json'),
        JSON.stringify({
          name: 'docker-cancellation-test',
          version: '1.0.0',
          scripts: {
            build: 'node -e "setInterval(() => {}, 1000)"',
          },
        }),
      );

      const controller = new AbortController();

      const execution = executor.execute(workspacePath, analysisId, 'BUILD', {
        signal: controller.signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      controller.abort();

      const result = await execution;

      expect(result.cancelled).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).not.toBe(0);
    },
    30_000,
  );
});
