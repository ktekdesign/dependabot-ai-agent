import { z } from 'zod';

const providerSchema = z.enum(['openai', 'anthropic', 'google']);

const environmentSchema = z.object({
  AI_PROVIDER: providerSchema.default('openai'),
  AI_MODEL: z.string().trim().min(1).optional(),

  OPENAI_MODEL: z.string().trim().min(1).optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).optional(),
  GOOGLE_MODEL: z.string().trim().min(1).optional(),

  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),

  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
});

export type AIProviderName = z.infer<typeof providerSchema>;

export interface AIProviderSettings {
  model: string;
  apiKey?: string;
}

export interface AIProviderConfig {
  provider: AIProviderName;
  model: string;
  temperature: number;
  apiKey?: string;
  providers: Record<AIProviderName, AIProviderSettings>;
}

const defaultModels: Record<AIProviderName, string> = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-2.5-flash',
};

export function loadAIProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AIProviderConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(
      `Invalid AI provider configuration: ${z.prettifyError(parsed.error)}`,
    );
  }

  const values = parsed.data;

  const providers: Record<AIProviderName, AIProviderSettings> = {
    openai: {
      model:
        values.OPENAI_MODEL ??
        (values.AI_PROVIDER === 'openai' ? values.AI_MODEL : undefined) ??
        defaultModels.openai,
      apiKey: values.OPENAI_API_KEY,
    },
    anthropic: {
      model:
        values.ANTHROPIC_MODEL ??
        (values.AI_PROVIDER === 'anthropic' ? values.AI_MODEL : undefined) ??
        defaultModels.anthropic,
      apiKey: values.ANTHROPIC_API_KEY,
    },
    google: {
      model:
        values.GOOGLE_MODEL ??
        (values.AI_PROVIDER === 'google' ? values.AI_MODEL : undefined) ??
        defaultModels.google,
      apiKey: values.GOOGLE_API_KEY,
    },
  };

  const selectedProvider = values.AI_PROVIDER;
  const selectedSettings = providers[selectedProvider];

  return {
    provider: selectedProvider,
    model: selectedSettings.model,
    temperature: values.AI_TEMPERATURE,
    apiKey: selectedSettings.apiKey,
    providers,
  };
}
