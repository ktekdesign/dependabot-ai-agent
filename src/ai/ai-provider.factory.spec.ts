import { AIProviderFactory } from './ai-provider.factory';
import { AIProviderConfig } from './config/ai-provider.config';
import { OpenAIProvider } from './adapters/openai.provider';
import { AnthropicProvider } from './adapters/anthropic.provider';
import { GoogleProvider } from './adapters/google.provider';

describe('AIProviderFactory', () => {
  const originalEnvironment = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };

  const config: AIProviderConfig = {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    temperature: 0.2,
    apiKey: 'openai-test-key',
    providers: {
      openai: {
        model: 'gpt-4.1-mini',
        apiKey: 'openai-test-key',
      },
      anthropic: {
        model: 'claude-sonnet-4-20250514',
        apiKey: 'anthropic-test-key',
      },
      google: {
        model: 'gemini-2.5-flash',
        apiKey: 'google-test-key',
      },
    },
  };

  let factory: AIProviderFactory;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'openai-test-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';
    process.env.GOOGLE_API_KEY = 'google-test-key';

    factory = new AIProviderFactory(config);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('should create OpenAI provider by default', () => {
    expect(factory.create()).toBeInstanceOf(OpenAIProvider);
  });

  it('should create Anthropic provider when selected', () => {
    expect(factory.create('anthropic')).toBeInstanceOf(AnthropicProvider);
  });

  it('should create Google provider when selected', () => {
    expect(factory.create('google')).toBeInstanceOf(GoogleProvider);
  });

  it('should use the configured provider when no provider is specified', () => {
    const provider = factory.create();

    expect(provider).toBeInstanceOf(OpenAIProvider);
  });

  it('should allow selecting another provider without changing the default', () => {
    factory.create('anthropic');

    expect(factory.create()).toBeInstanceOf(OpenAIProvider);
  });

  it('should reject generation when the selected provider has no API key', async () => {
    const configWithoutAnthropicKey: AIProviderConfig = {
      ...config,
      providers: {
        ...config.providers,
        anthropic: {
          ...config.providers.anthropic,
          apiKey: undefined,
        },
      },
    };

    const provider = new AIProviderFactory(configWithoutAnthropicKey).create(
      'anthropic',
    );

    await expect(
      provider.generate({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toThrow('Missing API key for AI provider: anthropic');
  });
});
