import { z } from 'zod';
import { AIRequest, AIResponse } from './ai-message.interface';

export interface AIProvider {
  generate(request: AIRequest): Promise<AIResponse>;

  generateStructured<T extends Record<string, unknown>>(
    request: AIRequest,
    schema: z.ZodType<T>,
  ): Promise<T>;
}
