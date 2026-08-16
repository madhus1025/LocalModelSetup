import type { ModelMessage } from "../llm/types";

export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const codePunctuation = (text.match(/[{}()[\];,.<>:=]/g) ?? []).length;
  return Math.ceil(text.length / 4 + codePunctuation / 12);
}

export function estimateMessageTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => {
    const toolCallTokens =
      message.toolCalls?.reduce(
        (sum, call) =>
          sum +
          estimateTextTokens(call.function.name) +
          estimateTextTokens(call.function.arguments),
        0
      ) ?? 0;
    return (
      total +
      6 +
      estimateTextTokens(message.content) +
      estimateTextTokens(message.reasoningContent ?? "") +
      toolCallTokens
    );
  }, 0);
}
