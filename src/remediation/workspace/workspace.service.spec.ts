import { WorkspaceService } from './workspace.service';
import { lstat, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRemediationConfig } from '../config/remediation.config';

describe('WorkspaceService', () => {
  let root: string;
  let outsideDirectory: string;
  let service: WorkspaceService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dependabot-workspace-test-'));
    outsideDirectory = await mkdtemp(
      join(tmpdir(), 'dependabot-workspace-outside-'),
    );

    service = new WorkspaceService(
      loadRemediationConfig({
        REMEDIATION_WORKSPACE_ROOT: join(root, 'workspaces'),
      }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  });

  it('creates an isolated workspace for an analysis', async () => {
    const analysisId = randomUUID();

    const workspace = await service.createWorkspace(analysisId);
    const stats = await lstat(workspace.path);

    expect(workspace.analysisId).toBe(analysisId);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('rejects invalid analysis IDs', async () => {
    await expect(service.createWorkspace('../../outside')).rejects.toThrow(
      'Invalid analysis ID',
    );
  });

  it('does not allow duplicate workspace creation', async () => {
    const analysisId = randomUUID();

    await service.createWorkspace(analysisId);

    await expect(service.createWorkspace(analysisId)).rejects.toThrow();
  });

  it('destroys a workspace inside the configured root', async () => {
    const workspace = await service.createWorkspace(randomUUID());

    await service.destroyWorkspace(workspace.path);

    await expect(lstat(workspace.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects attempts to destroy directories outside the workspace root', async () => {
    const outsideWorkspace = join(outsideDirectory, randomUUID());
    await mkdir(outsideWorkspace);

    await expect(service.destroyWorkspace(outsideWorkspace)).rejects.toThrow(
      'Workspace must be a direct child',
    );

    await expect(lstat(outsideWorkspace)).resolves.toBeDefined();
  });

  it('rejects symbolic links as workspaces', async () => {
    const analysisId = randomUUID();
    const workspaceRoot = join(root, 'workspaces');

    await mkdir(workspaceRoot, { recursive: true });
    await symlink(outsideDirectory, join(workspaceRoot, analysisId));

    await expect(
      service.destroyWorkspace(join(workspaceRoot, analysisId)),
    ).rejects.toThrow('Workspace must be a real directory');

    await expect(lstat(outsideDirectory)).resolves.toBeDefined();
  });

  it('rejects workspace paths without a valid UUID', async () => {
    const workspaceRoot = join(root, 'workspaces');
    await mkdir(workspaceRoot, { recursive: true });

    const invalidWorkspace = join(workspaceRoot, 'invalid-workspace');
    await mkdir(invalidWorkspace);

    await expect(service.destroyWorkspace(invalidWorkspace)).rejects.toThrow(
      'Invalid analysis ID',
    );

    await expect(lstat(invalidWorkspace)).resolves.toBeDefined();
  });

  it('rejects a UUID workspace path outside the configured root', async () => {
    const outsideWorkspace = join(outsideDirectory, randomUUID());
    await mkdir(outsideWorkspace);

    await expect(service.destroyWorkspace(outsideWorkspace)).rejects.toThrow(
      'Workspace must be a direct child',
    );

    await expect(lstat(outsideWorkspace)).resolves.toBeDefined();
  });

  it('restricts workspace root permissions to owner only', async () => {
    await service.createWorkspace(randomUUID());

    const workspaceRoot = join(root, 'workspaces');
    const stats = await lstat(workspaceRoot);

    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it('rejects a symbolic link as workspace root', async () => {
    const actualRoot = join(root, 'actual-workspaces');
    const linkedRoot = join(root, 'linked-workspaces');

    await mkdir(actualRoot);
    await symlink(actualRoot, linkedRoot);

    const linkedService = new WorkspaceService(
      loadRemediationConfig({
        REMEDIATION_WORKSPACE_ROOT: linkedRoot,
      }),
    );

    await expect(linkedService.createWorkspace(randomUUID())).rejects.toThrow(
      'Workspace root must be a real directory',
    );
  });
});
