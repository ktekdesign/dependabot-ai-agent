require('dotenv/config');

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { SyncService } = require('../dist/src/sync/sync.service');

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const syncService = app.get(SyncService, { strict: false });

    console.log('Starting GitHub synchronization...');

    const result = await syncService.sync();

    console.log('\n========== SYNC SUMMARY ==========');
    console.log(`Repositories discovered: ${result.discovered}`);
    console.log(`Repositories enabled: ${result.enabled}`);
    console.log(`Repositories disabled: ${result.disabled}`);
    console.log(`Repositories failed: ${result.failed}`);
    console.log(`Alerts synchronized: ${result.alertsSynced}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Synchronization failed:', error);
  process.exit(1);
});
