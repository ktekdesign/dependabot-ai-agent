import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIRequest } from '../contracts/ai-message.interface';
import { AIProviderConfig } from '../config/ai-provider.config';
import { BaseLangChainProvider } from './base-langchain.provider';

export class AnthropicProvider extends BaseLangChainProvider {
  constructor(config: AIProviderConfig) {
    super(config);
  }

  protected createModel(request: AIRequest): BaseChatModel {
    return new ChatAnthropic({
      anthropicApiKey: this.getApiKey(),
      model: this.config.model,
      temperature: request.temperature ?? this.config.temperature,
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : {}),
    });
  }
}
