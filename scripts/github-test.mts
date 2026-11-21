import 'dotenv/config';
import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { readFileSync } from 'node:fs';

async function main() {
  const app = new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH!, 'utf8'),
    Octokit,
  });

  const octokit = await app.getInstallationOctokit(
    Number(process.env.GITHUB_INSTALLATION_ID),
  );

  // Retrieve every repository accessible to the installation.
  const repositories = await octokit.paginate(
    octokit.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  );

  console.log(`Repositories found: ${repositories.length}`);

  let totalAlerts = 0;
  let enabledRepositories = 0;
  let disabledRepositories = 0;
  let failedRepositories = 0;

  for (const repo of repositories) {
    console.log(`\nRepository: ${repo.full_name}`);

    try {
      // Retrieve all open Dependabot alerts.
      const alerts = await octokit.paginate(
        octokit.rest.dependabot.listAlertsForRepo,
        {
          owner: repo.owner.login,
          repo: repo.name,
          state: 'open',
          per_page: 100,
        },
      );

      enabledRepositories++;
      totalAlerts += alerts.length;

      console.log(`Status: ENABLED`);
      console.log(`Open alerts: ${alerts.length}`);

      for (const alert of alerts) {
        console.log({
          number: alert.number,
          package: alert.dependency.package.name,
          ecosystem: alert.dependency.package.ecosystem,
          severity: alert.security_vulnerability?.severity,
          cve: alert.security_advisory?.cve_id,
          patchedVersion:
            alert.security_vulnerability?.first_patched_version?.identifier ??
            null,
          manifest: alert.dependency.manifest_path,
        });
      }
    } catch (error) {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? error.status
          : undefined;

      const message = error instanceof Error ? error.message : 'Unknown error';

      if (
        status === 403 &&
        message.toLowerCase().includes('dependabot alerts are disabled')
      ) {
        disabledRepositories++;
        console.log('Status: NOT_ENABLED');
      } else {
        failedRepositories++;
        console.error(`Status: ERROR (${status ?? 'unknown'})`);
        console.error(message);
      }
    }
  }

  console.log('\n========== COLLECTION SUMMARY ==========');
  console.log(`Repositories discovered: ${repositories.length}`);
  console.log(`Repositories enabled: ${enabledRepositories}`);
  console.log(`Repositories disabled: ${disabledRepositories}`);
  console.log(`Repositories failed: ${failedRepositories}`);
  console.log(`Total open alerts: ${totalAlerts}`);
}

main().catch((error) => {
  console.error('Collector execution failed:', error.message);
  process.exit(1);
});
