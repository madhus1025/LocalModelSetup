import type { ModelMessage } from "../llm/types";
import { estimateMessageTokens } from "./tokenEstimator";

export interface ConversationSummarizer {
  summarize(messages: ModelMessage[], signal: AbortSignal): Promise<string>;
}

export interface ContextPreparation {
  messages: ModelMessage[];
  estimatedTokens: number;
  compacted: boolean;
}

export class ContextBudgetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export class ContextManager {
  public constructor(
    private readonly contextLimit: number | (() => number),
    private readonly reservedOutputTokens: number | (() => number),
    private readonly summarizer: ConversationSummarizer,
    private readonly onCompacted: (detail: string) => void
  ) {}

  public async prepare(
    messages: ModelMessage[],
    signal: AbortSignal
  ): Promise<ContextPreparation> {
    const budget =
      resolveNumber(this.contextLimit) -
      resolveNumber(this.reservedOutputTokens);
    const currentTokens = estimateMessageTokens(messages);
    if (currentTokens <= budget * 0.82) {
      return {
        messages,
        estimatedTokens: currentTokens,
        compacted: false
      };
    }

    const systemMessages = messages.filter(
      (message) => message.role === "system"
    );
    const nonSystemMessages = messages.filter(
      (message) => message.role !== "system"
    );
    const retentionStart = findRetentionStart(nonSystemMessages, 12);
    const retained = nonSystemMessages.slice(retentionStart);
    const compactable = nonSystemMessages.slice(0, retentionStart);
    if (compactable.length === 0) {
      throw new ContextBudgetError(
        `The current request needs approximately ${currentTokens} tokens, exceeding the ${budget}-token input budget. Narrow the requested context or raise the configured context length.`
      );
    }

    const summary = await this.summarizer.summarize(compactable, signal);
    if (summary.trim().length === 0) {
      throw new ContextBudgetError(
        "Conversation compaction returned an empty summary; no context was removed."
      );
    }
    const compactedMessages: ModelMessage[] = [
      ...mergeLeadingSystemMessages(systemMessages),
      {
        role: "user",
        content:
          "Conversation memory (explicitly compacted). Preserve these facts, decisions, modifications, failures, and unverified work:\n\n" +
          summary
      },
      ...retained
    ];
    const compactedTokens = estimateMessageTokens(compactedMessages);
    if (compactedTokens > budget) {
      throw new ContextBudgetError(
        `Compaction still requires approximately ${compactedTokens} tokens, exceeding the ${budget}-token input budget.`
      );
    }
    this.onCompacted(
      `Compacted ${compactable.length} older messages into explicit conversation memory.`
    );
    return {
      messages: compactedMessages,
      estimatedTokens: compactedTokens,
      compacted: true
    };
  }
}

function resolveNumber(value: number | (() => number)): number {
  return typeof value === "function" ? value() : value;
}

function mergeLeadingSystemMessages(
  systemMessages: readonly ModelMessage[]
): ModelMessage[] {
  const contents = systemMessages
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0);
  if (contents.length === 0) {
    return [];
  }
  return [{ role: "system", content: contents.join("\n\n") }];
}

function findRetentionStart(
  messages: readonly ModelMessage[],
  targetCount: number
): number {
  let start = Math.max(0, messages.length - targetCount);
  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }
  return start;
}
