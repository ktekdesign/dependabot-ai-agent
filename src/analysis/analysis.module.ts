import { Module } from '@nestjs/common';

import { QueueModule } from '../queue/queue.module';
import { AIModule } from '../ai/ai.module';

import { AnalysisProcessor } from './analysis.processor';
import { AnalysisRecoveryScheduler } from './analysis-recovery.scheduler';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [QueueModule, AIModule],
  providers: [AnalysisService, AnalysisProcessor, AnalysisRecoveryScheduler],
})
export class AnalysisModule {}
