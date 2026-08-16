import { isRecord } from "../shared/json";
import type { TokenUsage } from "../shared/protocol";
import { SseDecoder } from "./sseDecoder";
import type {
  ModelClient,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStatus,
  ModelStreamCallbacks,
  ModelToolCall
} from "./types";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export class ModelProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

export class OpenAiCompatibleClient implements ModelClient {
  public constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly fetchImplementation: FetchLike = fetch
  ) {}

  public async checkStatus(signal?: AbortSignal): Promise<ModelStatus> {
    const timeout = new AbortController();
    const timeoutId = setTimeout(() => timeout.abort(), 5_000);
    const combined = combineSignals(signal, timeout.signal);

    try {
      const response = await this.fetchImplementation(
        `${this.endpoint}/models`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: combined
        }
      );
      if (!response.ok) {
        return {
          ready: false,
          detail: `Model endpoint returned HTTP ${response.status}.`,
          availableModels: []
        };
      }
      const payload: unknown = await response.json();
      const availableModels = extractModelIds(payload);
      const modelAvailable =
        availableModels.length === 0 || availableModels.includes(this.model);
      return {
        ready: modelAvailable,
        detail: modelAvailable
          ? `Connected to ${this.endpoint}.`
          : `Connected, but model "${this.model}" was not advertised.`,
        availableModels
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ready: false,
          detail: "Model status check timed out or was cancelled.",
          availableModels: []
        };
      }
      return {
        ready: false,
        detail: error instanceof Error ? error.message : String(error),
        availableModels: []
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async streamChat(
    request: ModelRequest,
    callbacks: ModelStreamCallbacks
  ): Promise<ModelResponse> {
    const response = await this.fetchImplementation(
      `${this.endpoint}/chat/completions`,
      {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(toRequestBody(this.model, request)),
        signal: request.signal
      }
    );

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new Error(
        `Model request failed with HTTP ${response.status}${
          detail.length > 0 ? `: ${detail}` : "."
        }`
      );
    }
    if (response.body === null) {
      throw new ModelProtocolError("Model response did not include a body.");
    }

    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    const reader = response.body.getReader();
    const accumulator = new StreamAccumulator(callbacks);

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        const text = decoder.decode(result.value, { stream: true });
        for (const event of sse.push(text)) {
          if (event.data === "[DONE]") {
            return accumulator.finish();
          }
          accumulator.consume(event.data);
        }
      }

      const finalText = decoder.decode();
      for (const event of [...sse.push(finalText), ...sse.flush()]) {
        if (event.data !== "[DONE]") {
          accumulator.consume(event.data);
        }
      }
      return accumulator.finish();
    } catch (error) {
      if (isAbortError(error) || request.signal.aborted) {
        throw new DOMException("Model generation was cancelled.", "AbortError");
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

class StreamAccumulator {
  private content = "";
  private reasoningContent = "";
  private finishReason: string | null = null;
  private usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimated: true
  };
  private readonly toolCalls = new Map<
    number,
    {
      id: string;
      name: string;
      arguments: string;
    }
  >();

  public constructor(private readonly callbacks: ModelStreamCallbacks) {}

  public consume(data: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new ModelProtocolError("Model endpoint emitted invalid SSE JSON.");
    }
    if (!isRecord(payload)) {
      throw new ModelProtocolError("Model stream event was not an object.");
    }

    this.consumeUsage(payload.usage);
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return;
    }
    const choice = choices[0];
    if (!isRecord(choice)) {
      return;
    }
    if (typeof choice.finish_reason === "string") {
      this.finishReason = choice.finish_reason;
    }
    if (!isRecord(choice.delta)) {
      return;
    }

    const delta = choice.delta;
    if (typeof delta.content === "string") {
      this.content += delta.content;
      this.callbacks.onTextDelta(delta.content);
    }
    const reasoning = extractReasoning(delta);
    if (reasoning.length > 0) {
      this.reasoningContent += reasoning;
      this.callbacks.onReasoningDelta?.(reasoning);
      this.callbacks.onReasoningTokens?.(estimateTokens(reasoning));
    }
    this.consumeToolCalls(delta.tool_calls);
  }

  public finish(): ModelResponse {
    const toolCalls: ModelToolCall[] = [...this.toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        id: call.id.length > 0 ? call.id : `tool-call-${index}`,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments
        }
      }));

    if (this.usage.totalTokens === 0) {
      const completionTokens = estimateTokens(
        this.content + this.reasoningContent
      );
      this.usage = {
        promptTokens: 0,
        completionTokens,
        totalTokens: completionTokens,
        estimated: true
      };
    }
    return {
      content: this.content,
      reasoningContent: this.reasoningContent,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage
    };
  }

  private consumeUsage(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }
    const promptTokens = numericTokenValue(value.prompt_tokens);
    const completionTokens = numericTokenValue(value.completion_tokens);
    const totalTokens = numericTokenValue(value.total_tokens);
    if (
      promptTokens !== undefined &&
      completionTokens !== undefined &&
      totalTokens !== undefined
    ) {
      this.usage = {
        promptTokens,
        completionTokens,
        totalTokens,
        estimated: false
      };
    }
  }

  private consumeToolCalls(value: unknown): void {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (!isRecord(item)) {
        continue;
      }
      const index =
        typeof item.index === "number" && Number.isInteger(item.index)
          ? item.index
          : 0;
      const existing = this.toolCalls.get(index) ?? {
        id: "",
        name: "",
        arguments: ""
      };
      if (typeof item.id === "string") {
        existing.id = item.id;
      }
      if (isRecord(item.function)) {
        if (typeof item.function.name === "string") {
          existing.name += item.function.name;
        }
        if (typeof item.function.arguments === "string") {
          existing.arguments += item.function.arguments;
        } else if (isRecord(item.function.arguments)) {
          existing.arguments += JSON.stringify(item.function.arguments);
        }
      }
      this.toolCalls.set(index, existing);
    }
  }
}

function normalizeSystemMessages(
  messages: readonly ModelMessage[]
): ModelMessage[] {
  let leadingCount = 0;
  while (
    leadingCount < messages.length &&
    messages[leadingCount]!.role === "system"
  ) {
    leadingCount += 1;
  }

  const leadingContent = messages
    .slice(0, leadingCount)
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0);
  const rest = messages
    .slice(leadingCount)
    .map((message) =>
      message.role === "system"
        ? { ...message, role: "user" as const }
        : message
    );

  if (leadingContent.length === 0) {
    return rest;
  }
  return [{ role: "system", content: leadingContent.join("\n\n") }, ...rest];
}

function toRequestBody(model: string, request: ModelRequest): object {
  return {
    model,
    messages: normalizeSystemMessages(request.messages).map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name === undefined ? {} : { name: message.name }),
      ...(message.toolCallId === undefined
        ? {}
        : { tool_call_id: message.toolCallId }),
      ...(message.toolCalls === undefined
        ? {}
        : { tool_calls: message.toolCalls }),
      ...(message.reasoningContent === undefined
        ? {}
        : { reasoning_content: message.reasoningContent })
    })),
    tools: request.tools,
    tool_choice: request.tools === undefined ? undefined : "auto",
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    top_p: request.topP,
    top_k: request.topK,
    chat_template_kwargs: {
      enable_thinking: request.enableThinking,
      preserve_thinking: request.preserveThinking
    }
  };
}

function extractModelIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }
  return payload.data.flatMap((item) =>
    isRecord(item) && typeof item.id === "string" ? [item.id] : []
  );
}

function extractReasoning(delta: Record<string, unknown>): string {
  if (typeof delta.reasoning_content === "string") {
    return delta.reasoning_content;
  }
  return typeof delta.reasoning === "string" ? delta.reasoning : "";
}

function numericTokenValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

async function readErrorBody(response: Response): Promise<string> {
  const body = await response.text();
  return body.slice(0, 2_000).replace(/\s+/g, " ").trim();
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal
): AbortSignal {
  if (first === undefined) {
    return second;
  }
  if (first.aborted || second.aborted) {
    return AbortSignal.abort();
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
