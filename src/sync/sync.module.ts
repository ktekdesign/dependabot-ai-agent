import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncLockService } from './sync-lock.service';
import { GitHubModule } from '../github/github.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [GitHubModule, RepositoriesModule, AlertsModule],
  providers: [SyncService, SyncLockService],
  exports: [SyncService],
})
export class SyncModule {}
