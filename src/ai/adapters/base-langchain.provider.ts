import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { z } from 'zod';

import { AIRequest, AIResponse } from '../contracts/ai-message.interface';
import { AIProvider } from '../contracts/ai-provider.interface';
import { AIProviderConfig } from '../config/ai-provider.config';

export abstract class BaseLangChainProvider implements AIProvider {
  protected constructor(protected readonly config: AIProviderConfig) {}

  protected abstract createModel(request: AIRequest): BaseChatModel;

  private toLangChainMessages(request: AIRequest) {
    return request.messages.map((message) => {
      switch (message.role) {
        case 'system':
          return new SystemMessage(message.content);
        case 'assistant':
          return new AIMessage(message.content);
        case 'user':
          return new HumanMessage(message.content);
      }
    });
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const model = this.createModel(request);
    const response = await model.invoke(this.toLangChainMessages(request));

    const content =
      typeof response.content === 'string'
        ? response.content
        : response.content
            .filter(
              (block): block is { type: 'text'; text: string } =>
                typeof block === 'object' &&
                block !== null &&
                'type' in block &&
                block.type === 'text' &&
                'text' in block &&
                typeof block.text === 'string',
            )
            .map((block) => block.text)
            .join('\n');

    const metadata = response.usage_metadata;
    const usageRecord =
      typeof metadata === 'object' && metadata !== null
        ? (metadata as Record<string, unknown>)
        : undefined;

    const inputTokens =
      typeof usageRecord?.input_tokens === 'number'
        ? usageRecord.input_tokens
        : undefined;

    const outputTokens =
      typeof usageRecord?.output_tokens === 'number'
        ? usageRecord.output_tokens
        : undefined;

    const usage =
      inputTokens !== undefined || outputTokens !== undefined
        ? { inputTokens, outputTokens }
        : undefined;

    return {
      content,
      provider: this.config.provider,
      model: this.config.model,
      usage,
    };
  }

  async generateStructured<T extends Record<string, unknown>>(
    request: AIRequest,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const model = this.createModel(request);

    const structuredModel = model.withStructuredOutput(schema, {
      method: 'functionCalling',
    });

    const result = await structuredModel.invoke(
      this.toLangChainMessages(request),
    );

    return schema.parse(result);
  }

  protected getApiKey(): string {
    const apiKey = this.config.apiKey?.trim();

    if (!apiKey) {
      throw new Error(
        `Missing API key for AI provider: ${this.config.provider}`,
      );
    }

    return apiKey;
  }
}
