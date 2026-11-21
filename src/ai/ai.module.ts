import { Module } from '@nestjs/common';
import { loadAIProviderConfig } from './config/ai-provider.config';
import { AIProviderFactory } from './ai-provider.factory';

import { AI_PROVIDER_CONFIG } from './ai.constants';
import { AIService } from './ai.service';

@Module({
  providers: [
    {
      provide: AI_PROVIDER_CONFIG,
      useFactory: loadAIProviderConfig,
    },
    AIProviderFactory,
    AIService,
  ],
  exports: [AI_PROVIDER_CONFIG, AIProviderFactory],
})
export class AIModule {}
