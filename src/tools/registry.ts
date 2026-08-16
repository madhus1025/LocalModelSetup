import type { FunctionToolDefinition, ModelToolCall } from "../llm/types";
import type {
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult
} from "./types";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  public constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      const name = tool.definition.function.name;
      if (this.tools.has(name)) {
        throw new Error(`Duplicate tool registration: ${name}`);
      }
      this.tools.set(name, tool);
    }
  }

  public get definitions(): FunctionToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  public async execute(
    call: ModelToolCall,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.function.name);
    if (tool === undefined) {
      return errorResult(
        `Unknown tool "${call.function.name}". Use one of the advertised tools.`
      );
    }
    if (context.mode === "ask" && tool.kind !== "read") {
      return errorResult(
        `${call.function.name} is unavailable in Ask mode because it can change state.`
      );
    }
    if (context.mode === "edit" && tool.kind === "command") {
      return errorResult(
        `${call.function.name} is unavailable in Edit mode. Switch to Agent mode to execute commands.`
      );
    }
    if (context.signal.aborted) {
      throw new DOMException("Tool execution was cancelled.", "AbortError");
    }

    try {
      const rawArguments =
        call.function.arguments.trim().length === 0
          ? {}
          : (JSON.parse(call.function.arguments) as unknown);
      const parsed = tool.parse(rawArguments);
      const value = await tool.execute(parsed, context);
      const content = serializeBounded(
        value,
        context.maxToolOutputCharacters
      );
      return {
        content,
        isError: false,
        summary: summarizeResult(call.function.name, value)
      };
    } catch (error) {
      if (
        context.signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new DOMException("Tool execution was cancelled.", "AbortError");
      }
      return errorResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

function serializeBounded(value: unknown, maxCharacters: number): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length <= maxCharacters) {
    return serialized;
  }
  return JSON.stringify(
    {
      truncated: true,
      originalCharacters: serialized.length,
      visiblePrefix: serialized.slice(0, maxCharacters),
      instruction:
        "Use a narrower file range, search query, path, or command to retrieve the omitted data."
    },
    null,
    2
  );
}

function summarizeResult(name: string, value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "summary" in value &&
    typeof value.summary === "string"
  ) {
    return value.summary;
  }
  return `${name} completed.`;
}

function errorResult(message: string): ToolExecutionResult {
  return {
    content: JSON.stringify({ error: message }, null, 2),
    isError: true,
    summary: message
  };
}
