import { Injectable, Inject } from '@nestjs/common';
import { AIProviderConfig, AIProviderName } from './config/ai-provider.config';
import { AIProvider } from './contracts/ai-provider.interface';
import { AI_PROVIDER_CONFIG } from './ai.constants';
import { OpenAIProvider } from './adapters/openai.provider';
import { AnthropicProvider } from './adapters/anthropic.provider';
import { GoogleProvider } from './adapters/google.provider';

@Injectable()
export class AIProviderFactory {
  constructor(
    @Inject(AI_PROVIDER_CONFIG)
    private readonly config: AIProviderConfig,
  ) {}

  create(providerName: AIProviderName = this.config.provider): AIProvider {
    const settings = this.config.providers[providerName];

    const providerConfig: AIProviderConfig = {
      ...this.config,
      provider: providerName,
      model: settings.model,
      apiKey: settings.apiKey,
    };

    switch (providerName) {
      case 'openai':
        return new OpenAIProvider(providerConfig);

      case 'anthropic':
        return new AnthropicProvider(providerConfig);

      case 'google':
        return new GoogleProvider(providerConfig);
    }
  }
}
