import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIRequest } from '../contracts/ai-message.interface';
import { AIProviderConfig } from '../config/ai-provider.config';
import { BaseLangChainProvider } from './base-langchain.provider';

class TestLangChainProvider extends BaseLangChainProvider {
  constructor(
    config: AIProviderConfig,
    private readonly model: BaseChatModel,
  ) {
    super(config);
  }

  protected createModel(): BaseChatModel {
    return this.model;
  }
}

describe('BaseLangChainProvider', () => {
  const config = {
    provider: 'openai',
    model: 'test-model',
    temperature: 0.2,
    apiKey: 'test-key',
  } as AIProviderConfig;

  const request: AIRequest = {
    messages: [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Analyze this vulnerability' },
    ],
  };

  it('should generate structured output using the supplied Zod schema', async () => {
    const expected = { riskLevel: 'HIGH' };

    const invoke = jest.fn().mockResolvedValue(expected);
    const withStructuredOutput = jest.fn().mockReturnValue({ invoke });

    const model = {
      withStructuredOutput,
    } as unknown as BaseChatModel;

    const provider = new TestLangChainProvider(config, model);

    const { z } = await import('zod');
    const schema = z.object({
      riskLevel: z.enum(['HIGH', 'LOW']),
    });

    const result = await provider.generateStructured(request, schema);

    expect(result).toEqual(expected);
    expect(withStructuredOutput).toHaveBeenCalledWith(schema, {
      method: 'functionCalling',
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ content: 'System instruction' }),
        expect.objectContaining({ content: 'Analyze this vulnerability' }),
      ]),
    );
  });

  it('should reject structured output that does not match the schema', async () => {
    const invoke = jest.fn().mockResolvedValue({
      riskLevel: 'INVALID',
    });

    const model = {
      withStructuredOutput: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    const provider = new TestLangChainProvider(config, model);

    const { z } = await import('zod');
    const schema = z.object({
      riskLevel: z.enum(['HIGH', 'LOW']),
    });

    await expect(
      provider.generateStructured(request, schema),
    ).rejects.toThrow();
  });

  it('should propagate model errors', async () => {
    const error = new Error('Model invocation failed');
    const invoke = jest.fn().mockRejectedValue(error);

    const model = {
      withStructuredOutput: jest.fn().mockReturnValue({ invoke }),
    } as unknown as BaseChatModel;

    const provider = new TestLangChainProvider(config, model);

    const { z } = await import('zod');
    const schema = z.object({
      riskLevel: z.enum(['HIGH', 'LOW']),
    });

    await expect(provider.generateStructured(request, schema)).rejects.toThrow(
      error,
    );
  });
});
