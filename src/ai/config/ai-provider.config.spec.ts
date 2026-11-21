import { loadAIProviderConfig } from './ai-provider.config';

describe('loadAIProviderConfig', () => {
  it('should use OpenAI as the default provider', () => {
    const config = loadAIProviderConfig({});

    expect(config).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      temperature: 0.2,
      apiKey: undefined,
      providers: {
        openai: {
          model: 'gpt-4.1-mini',
          apiKey: undefined,
        },
        anthropic: {
          model: 'claude-sonnet-4-20250514',
          apiKey: undefined,
        },
        google: {
          model: 'gemini-2.5-flash',
          apiKey: undefined,
        },
      },
    });
  });

  it('should support Anthropic configuration', () => {
    const config = loadAIProviderConfig({
      AI_PROVIDER: 'anthropic',
      AI_MODEL: 'custom-model',
      ANTHROPIC_API_KEY: 'test-key',
    });

    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('custom-model');
    expect(config.apiKey).toBe('test-key');
  });

  it('should support Google configuration', () => {
    const config = loadAIProviderConfig({
      AI_PROVIDER: 'google',
      GOOGLE_API_KEY: 'test-key',
    });

    expect(config.provider).toBe('google');
    expect(config.model).toBe('gemini-2.5-flash');
    expect(config.apiKey).toBe('test-key');
  });

  it('should reject unsupported providers', () => {
    expect(() =>
      loadAIProviderConfig({
        AI_PROVIDER: 'unsupported',
      }),
    ).toThrow('Invalid AI provider configuration');
  });

  it('should reject invalid temperature', () => {
    expect(() =>
      loadAIProviderConfig({
        AI_TEMPERATURE: '3',
      }),
    ).toThrow('Invalid AI provider configuration');
  });

  it('should reject an empty model', () => {
    expect(() =>
      loadAIProviderConfig({
        AI_MODEL: ' ',
      }),
    ).toThrow('Invalid AI provider configuration');
  });

  it('should use independent models for each provider', () => {
    const config = loadAIProviderConfig({
      AI_PROVIDER: 'openai',
      OPENAI_MODEL: 'gpt-custom',
      ANTHROPIC_MODEL: 'claude-custom',
      GOOGLE_MODEL: 'gemini-custom',
    });

    expect(config.providers.openai.model).toBe('gpt-custom');
    expect(config.providers.anthropic.model).toBe('claude-custom');
    expect(config.providers.google.model).toBe('gemini-custom');
  });

  it('should apply AI_MODEL only to the selected default provider', () => {
    const config = loadAIProviderConfig({
      AI_PROVIDER: 'openai',
      AI_MODEL: 'my-openai-model',
    });

    expect(config.providers.openai.model).toBe('my-openai-model');
    expect(config.providers.anthropic.model).toBe('claude-sonnet-4-20250514');
  });
});
