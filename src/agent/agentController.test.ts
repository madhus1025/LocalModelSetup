import { describe, expect, it, vi } from "vitest";
import { ContextManager } from "../context/contextManager";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStatus
} from "../llm/types";
import type { ToolExecutionContext } from "../tools/types";
import { ToolRegistry } from "../tools/registry";
import { ConversationRepository, type MementoLike } from "./conversationRepository";
import { AgentController, type AgentEventSink } from "./agentController";

class MemoryMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string, defaultValue: T): T {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  public update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

class SequenceModel implements ModelClient {
  public calls = 0;

  public constructor(private readonly responses: ModelResponse[]) {}

  public checkStatus(): Promise<ModelStatus> {
    return Promise.resolve({
      ready: true,
      detail: "ready",
      availableModels: ["test"]
    });
  }

  public streamChat(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal.aborted) {
      return Promise.reject(new DOMException("cancelled", "AbortError"));
    }
    const response = this.responses[this.calls];
    this.calls += 1;
    if (response === undefined) {
      return Promise.reject(new Error("No fake response configured."));
    }
    return Promise.resolve(response);
  }
}

function response(
  content: string,
  toolCalls: ModelResponse["toolCalls"] = []
): ModelResponse {
  return {
    content,
    reasoningContent: "",
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: false
    }
  };
}

function createController(
  model: ModelClient,
  tools: ToolRegistry,
  maxIterations = 5,
  sinkOverride: Partial<AgentEventSink> = {}
) {
  const conversations = new ConversationRepository(new MemoryMemento());
  const notices: string[] = [];
  const manager = new ContextManager(
    65_536,
    4_096,
    { summarize: vi.fn(async () => "summary") },
    vi.fn()
  );
  const sink: AgentEventSink = {
    stateChanged: vi.fn(),
    assistantDelta: vi.fn(),
    assistantReasoningDelta: vi.fn(),
    notice: (_level, text) => notices.push(text),
    ...sinkOverride
  };
  const controller = new AgentController(
    conversations,
    model,
    tools,
    { build: vi.fn(async () => "repository context") },
    manager,
    () => ({ signal: new AbortController().signal }) as ToolExecutionContext,
    () => ({
      maxOutputTokens: 1_000,
      temperature: 1,
      topP: 0.95,
      topK: 20,
      enableThinking: true,
      preserveThinking: true,
      maxIterations,
      maxModelRetries: 0
    }),
    sink
  );
  return { controller, conversations, notices };
}

describe("AgentController", () => {
  it("executes tool calls and continues to a final response", async () => {
    const tool = {
      kind: "read" as const,
      definition: {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "read",
          parameters: {
            type: "object" as const,
            properties: {},
            additionalProperties: false
          }
        }
      },
      parse: () => ({}),
      execute: vi.fn(async () => ({ content: "file" }))
    };
    const model = new SequenceModel([
      response("", [
        {
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: "{}" }
        }
      ]),
      response("Done.")
    ]);
    const { controller, conversations } = createController(
      model,
      new ToolRegistry([tool])
    );

    await controller.run("Inspect the file.", "ask");

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(conversations.active.displayMessages.at(-1)?.content).toBe("Done.");
    expect(conversations.active.modelMessages.some(
      (message) => message.role === "tool"
    )).toBe(true);
  });

  it("streams reasoning to the sink and advances run-status phases", async () => {
    const reasoningDeltas: string[] = [];
    const holder: { controller?: AgentController } = {};
    let phaseWhileThinking: string | undefined;
    let phaseWhileResponding: string | undefined;

    const model: ModelClient = {
      checkStatus: () =>
        Promise.resolve({ ready: true, detail: "", availableModels: [] }),
      streamChat: (_request, callbacks) => {
        callbacks.onReasoningDelta?.("Let me plan the change. ");
        phaseWhileThinking = holder.controller?.runStatus?.phase;
        callbacks.onTextDelta("Final answer.");
        phaseWhileResponding = holder.controller?.runStatus?.phase;
        return Promise.resolve(response("Final answer."));
      }
    };

    const { controller, conversations } = createController(
      model,
      new ToolRegistry([]),
      5,
      {
        assistantReasoningDelta: (_id, delta) => reasoningDeltas.push(delta)
      }
    );
    holder.controller = controller;

    await controller.run("Do the thing.", "ask");

    expect(reasoningDeltas.join("")).toContain("Let me plan the change.");
    expect(phaseWhileThinking).toBe("thinking");
    expect(phaseWhileResponding).toBe("responding");
    expect(conversations.active.displayMessages.at(-1)?.content).toBe(
      "Final answer."
    );
    expect(controller.runStatus).toBeUndefined();
  });

  it("reports failed tools to the model instead of terminating the loop", async () => {
    const tool = {
      kind: "read" as const,
      definition: {
        type: "function" as const,
        function: {
          name: "failing_tool",
          description: "fails",
          parameters: {
            type: "object" as const,
            properties: {},
            additionalProperties: false
          }
        }
      },
      parse: () => ({}),
      execute: vi.fn(async () => {
        throw new Error("expected failure");
      })
    };
    const model = new SequenceModel([
      response("", [
        {
          id: "call-1",
          type: "function",
          function: { name: "failing_tool", arguments: "{}" }
        }
      ]),
      response("I could not inspect it.")
    ]);
    const { controller, conversations } = createController(
      model,
      new ToolRegistry([tool])
    );

    await controller.run("Try.", "ask");

    const toolMessage = conversations.active.modelMessages.find(
      (message) => message.role === "tool"
    );
    expect(toolMessage?.content).toContain("expected failure");
    expect(conversations.active.displayMessages.at(-1)?.content).toContain(
      "could not"
    );
  });

  it("stops at the configured iteration limit", async () => {
    const loopingCall = {
      id: "call",
      type: "function" as const,
      function: { name: "read_file", arguments: "{}" }
    };
    const model = new SequenceModel([
      response("", [loopingCall]),
      response("", [loopingCall])
    ]);
    const tool = {
      kind: "read" as const,
      definition: {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "read",
          parameters: {
            type: "object" as const,
            properties: {},
            additionalProperties: false
          }
        }
      },
      parse: () => ({}),
      execute: vi.fn(async () => ({}))
    };
    const { controller, notices } = createController(
      model,
      new ToolRegistry([tool]),
      2
    );

    await controller.run("Loop.", "ask");

    expect(notices.some((notice) => notice.includes("iteration limit"))).toBe(
      true
    );
  });

  it("records synthetic results for unanswered tool calls when cancelled", async () => {
    const controllerSignal = new AbortController();
    const firstTool = {
      kind: "read" as const,
      definition: {
        type: "function" as const,
        function: {
          name: "slow_tool",
          description: "slow",
          parameters: {
            type: "object" as const,
            properties: {},
            additionalProperties: false
          }
        }
      },
      parse: () => ({}),
      execute: vi.fn(
        async () =>
          new Promise<never>((_resolve, reject) => {
            controllerSignal.signal.addEventListener("abort", () =>
              reject(new DOMException("cancelled", "AbortError"))
            );
          })
      )
    };
    const model = new SequenceModel([
      response("", [
        {
          id: "call-1",
          type: "function",
          function: { name: "slow_tool", arguments: "{}" }
        },
        {
          id: "call-2",
          type: "function",
          function: { name: "slow_tool", arguments: "{}" }
        }
      ])
    ]);
    const { controller, conversations } = createController(
      model,
      new ToolRegistry([firstTool])
    );
    const pending = controller.run("Run tools.", "ask");
    await vi.waitFor(() => expect(firstTool.execute).toHaveBeenCalledOnce());
    controllerSignal.abort();
    controller.stop();
    await pending;

    const toolMessages = conversations.active.modelMessages.filter(
      (message) => message.role === "tool"
    );
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((message) => message.toolCallId)).toEqual([
      "call-1",
      "call-2"
    ]);
    expect(toolMessages.every((message) =>
      message.content.includes("cancelled")
    )).toBe(true);
  });
});
