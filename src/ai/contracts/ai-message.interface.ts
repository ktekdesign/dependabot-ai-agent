export type AIMessageRole = 'system' | 'user' | 'assistant';

export interface AIMessage {
  role: AIMessageRole;
  content: string;
}

export interface AIRequest {
  messages: AIMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface AIResponse {
  content: string;
  provider: string;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}
