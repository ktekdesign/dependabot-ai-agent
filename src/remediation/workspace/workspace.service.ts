import { Inject, Injectable } from '@nestjs/common';
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { REMEDIATION_CONFIG } from '../config/remediation-config.module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { RemediationConfig } from '../config/remediation.config';
export interface RemediationWorkspace {
  analysisId: string;
  path: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class WorkspaceService {
  private readonly configuredRoot: string;

  constructor(
    @Inject(REMEDIATION_CONFIG)
    config: RemediationConfig,
  ) {
    this.configuredRoot = resolve(
      config.workspaceRoot ??
        join(process.cwd(), '.temp', 'remediation-workspaces'),
    );
  }

  private async getWorkspaceRoot(): Promise<string> {
    await mkdir(this.configuredRoot, {
      recursive: true,
      mode: 0o700,
    });

    const rootStats = await lstat(this.configuredRoot);

    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('Workspace root must be a real directory');
    }

    await chmod(this.configuredRoot, 0o700);

    return realpath(this.configuredRoot);
  }

  async createWorkspace(analysisId: string): Promise<RemediationWorkspace> {
    if (!UUID_PATTERN.test(analysisId)) {
      throw new Error('Invalid analysis ID');
    }

    const root = await this.getWorkspaceRoot();
    const workspacePath = join(root, analysisId);

    await mkdir(workspacePath, {
      recursive: false,
      mode: 0o700,
    });

    await chmod(workspacePath, 0o700);

    return {
      analysisId,
      path: workspacePath,
    };
  }

  async destroyWorkspace(workspacePath: string): Promise<void> {
    if (!isAbsolute(workspacePath)) {
      throw new Error('Workspace path must be absolute');
    }

    const target = resolve(workspacePath);
    const analysisId = basename(target);

    await this.validateWorkspace(target, analysisId);

    await rm(target, {
      recursive: true,
      force: false,
    });
  }

  async validateWorkspace(
    workspacePath: string,
    analysisId: string,
  ): Promise<string> {
    if (!UUID_PATTERN.test(analysisId)) {
      throw new Error('Invalid analysis ID');
    }

    if (!isAbsolute(workspacePath)) {
      throw new Error('Workspace path must be absolute');
    }

    const target = resolve(workspacePath);

    if (basename(target) !== analysisId) {
      throw new Error('Workspace path does not match analysis ID');
    }

    const root = await this.getWorkspaceRoot();
    const parent = await realpath(dirname(target));

    if (parent !== root) {
      throw new Error('Workspace must be a direct child of the workspace root');
    }

    const stats = await lstat(target);

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Workspace must be a real directory');
    }

    const canonicalPath = await realpath(target);

    if (canonicalPath !== target) {
      throw new Error('Workspace path must be canonical');
    }

    return canonicalPath;
  }
}
