import { Injectable } from '@nestjs/common';
import { AlertState } from '@prisma/client';

import { GitHubService } from '../github/github.service';
import { RepositoriesService } from '../repositories/repositories.service';
import { AlertsService, AlertInput } from '../alerts/alerts.service';
import { SyncLockService } from './sync-lock.service';

@Injectable()
export class SyncService {
  constructor(
    private readonly github: GitHubService,
    private readonly repositories: RepositoriesService,
    private readonly alerts: AlertsService,
    private readonly syncLock: SyncLockService,
  ) {}

  async sync() {
    const lock = await this.syncLock.acquire();

    if (!lock) {
      console.log('Synchronization skipped: another sync is running.');

      return {
        discovered: 0,
        enabled: 0,
        disabled: 0,
        failed: 0,
        alertsSynced: 0,
        skipped: true,
      };
    }

    try {
      return await this.executeSync();
    } finally {
      await this.syncLock.release(lock);
    }
  }
  private async executeSync() {
    const githubRepositories = await this.github.getRepositories();

    const summary = {
      discovered: githubRepositories.length,
      enabled: 0,
      disabled: 0,
      failed: 0,
      alertsSynced: 0,
    };

    for (const repo of githubRepositories) {
      const owner = repo.owner.login;
      const name = repo.name;
      const fullName = repo.full_name;

      await this.repositories.syncRepository({
        githubId: repo.id,
        owner,
        name,
        fullName,
      });

      try {
        const githubAlerts = await this.github.getAlerts(owner, name);

        const alerts: AlertInput[] = githubAlerts.map((alert) => ({
          number: alert.number,
          packageName: alert.dependency.package.name,
          ecosystem: alert.dependency.package.ecosystem,
          severity: alert.security_vulnerability?.severity ?? null,
          cveId: alert.security_advisory?.cve_id ?? null,
          vulnerableVersion:
            alert.security_vulnerability?.vulnerable_version_range ?? null,
          patchedVersion:
            alert.security_vulnerability?.first_patched_version?.identifier ??
            null,
          manifestPath: alert.dependency.manifest_path,
          state:
            alert.state === 'dismissed'
              ? AlertState.DISMISSED
              : alert.state === 'fixed'
                ? AlertState.FIXED
                : alert.state === 'auto_dismissed'
                  ? AlertState.AUTO_DISMISSED
                  : AlertState.OPEN,
          firstDetectedAt: alert.created_at ? new Date(alert.created_at) : null,
          lastUpdatedAt: alert.updated_at ? new Date(alert.updated_at) : null,
        }));

        const result = await this.alerts.syncAlerts(fullName, alerts);

        await this.repositories.updateMonitoringStatus(fullName, 'ENABLED');

        summary.enabled++;
        summary.alertsSynced += result.synced;
      } catch (error) {
        const status =
          typeof error === 'object' && error !== null && 'status' in error
            ? error.status
            : undefined;

        const message =
          error instanceof Error ? error.message : 'Unknown error';

        const isDisabled =
          status === 403 &&
          message.toLowerCase().includes('dependabot alerts are disabled');

        if (isDisabled) {
          await this.repositories.updateMonitoringStatus(
            fullName,
            'NOT_ENABLED',
          );
          summary.disabled++;
        } else {
          await this.repositories.updateMonitoringStatus(fullName, 'ERROR');
          summary.failed++;
          console.error(`Sync failed for ${fullName}:`, message);
        }
      }
    }

    return summary;
  }
}
