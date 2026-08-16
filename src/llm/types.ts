import type { JsonSchema } from "../shared/json";
import type { TokenUsage } from "../shared/protocol";

export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ModelToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  reasoningContent?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools?: FunctionToolDefinition[];
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  enableThinking: boolean;
  preserveThinking: boolean;
  signal: AbortSignal;
}

export interface ModelStreamCallbacks {
  onTextDelta(delta: string): void;
  onReasoningDelta?(delta: string): void;
  onReasoningTokens?(estimatedTokens: number): void;
}

export interface ModelResponse {
  content: string;
  reasoningContent: string;
  toolCalls: ModelToolCall[];
  finishReason: string | null;
  usage: TokenUsage;
}

export interface ModelStatus {
  ready: boolean;
  detail: string;
  availableModels: string[];
}

export interface ModelClient {
  checkStatus(signal?: AbortSignal): Promise<ModelStatus>;
  streamChat(
    request: ModelRequest,
    callbacks: ModelStreamCallbacks
  ): Promise<ModelResponse>;
}
