import type { ConversationSummarizer } from "../context/contextManager";
import type {
  ModelClient,
  ModelMessage
} from "../llm/types";

export class ModelConversationSummarizer
  implements ConversationSummarizer
{
  public constructor(
    private readonly client: ModelClient,
    private readonly temperature = 0.2
  ) {}

  public async summarize(
    messages: ModelMessage[],
    signal: AbortSignal
  ): Promise<string> {
    const transcript = messages
      .map((message) => {
        const toolCalls =
          message.toolCalls === undefined
            ? ""
            : `\nTool calls: ${JSON.stringify(message.toolCalls)}`;
        return `[${message.role}] ${message.content}${toolCalls}`;
      })
      .join("\n\n");
    const response = await this.client.streamChat(
      {
        messages: [
          {
            role: "system",
            content:
              "Compact a coding-agent transcript. Preserve user intent, repository facts, decisions, modified files, exact errors, commands and outcomes, pending approvals, unresolved hypotheses, and anything not yet verified. Do not invent facts. Return plain text with short labeled sections."
          },
          { role: "user", content: transcript }
        ],
        maxTokens: 2_048,
        temperature: this.temperature,
        topP: 0.9,
        topK: 20,
        enableThinking: false,
        preserveThinking: false,
        signal
      },
      { onTextDelta: () => undefined }
    );
    return response.content;
  }
}
