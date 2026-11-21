import { Module } from '@nestjs/common';

import { DatabaseModule } from './database/database.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RepositoriesModule } from './repositories/repositories.module';
import { AlertsModule } from './alerts/alerts.module';
import { GitHubModule } from './github/github.module';
import { SyncModule } from './sync/sync.module';
import { QueueModule } from './queue/queue.module';
import { OutboxModule } from './outbox/outbox.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AnalysisModule } from './analysis/analysis.module';
import { LangGraphCheckpointerModule } from './workflows/checkpointer/langgraph-checkpointer.module';
import { AIModule } from './ai/ai.module';
import { RemediationModule } from './remediation/remediation.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    RepositoriesModule,
    AlertsModule,
    GitHubModule,
    SyncModule,
    QueueModule,
    OutboxModule,
    AnalysisModule,
    LangGraphCheckpointerModule,
    AIModule,
    RemediationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
