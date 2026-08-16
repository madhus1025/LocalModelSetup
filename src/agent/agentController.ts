import { randomUUID } from "node:crypto";
import {
  noOpAuditSink,
  type AuditSink
} from "../audit/types";
import type { ContextManager } from "../context/contextManager";
import type { RepositoryContextSource } from "../context/repositoryContext";
import type {
  ModelClient,
  ModelMessage,
  ModelResponse,
  ModelToolCall
} from "../llm/types";
import type {
  AgentMode,
  ToolActivity,
  TokenUsage,
  RunStatus,
  RunPhase
} from "../shared/protocol";
import type { ToolRegistry } from "../tools/registry";
import type { ToolExecutionContext } from "../tools/types";
import type { ConversationRepository } from "./conversationRepository";
import { buildSystemPrompt } from "./systemPrompt";

export interface AgentRunConfiguration {
  maxOutputTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  enableThinking: boolean;
  preserveThinking: boolean;
  maxIterations: number;
  maxModelRetries: number;
}

export interface AgentEventSink {
  stateChanged(): void;
  assistantDelta(messageId: string, delta: string): void;
  assistantReasoningDelta(messageId: string, delta: string): void;
  notice(level: "info" | "warning" | "error", text: string): void;
}

export class AgentController {
  private abortController: AbortController | undefined;
  private readonly activityById = new Map<string, ToolActivity>();
  private progressStateTimer: NodeJS.Timeout | undefined;
  private runStatusValue: RunStatus | undefined;
  private running = false;

  public constructor(
    private readonly conversations: ConversationRepository,
    private readonly model: ModelClient,
    private readonly tools: ToolRegistry,
    private readonly repositoryContext: RepositoryContextSource,
    private readonly contextManager: ContextManager,
    private readonly createToolContext: (
      mode: AgentMode,
      signal: AbortSignal,
      onProgress: (detail: string) => void
    ) => ToolExecutionContext,
    private readonly readConfig: () => AgentRunConfiguration,
    private readonly sink: AgentEventSink,
    private readonly audit: AuditSink = noOpAuditSink
  ) {}

  public get isRunning(): boolean {
    return this.running;
  }

  public get activities(): ToolActivity[] {
    return [...this.activityById.values()].sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt)
    );
  }

  public get runStatus(): RunStatus | undefined {
    return this.runStatusValue === undefined
      ? undefined
      : { ...this.runStatusValue };
  }

  private setPhase(phase: RunPhase, toolName?: string): void {
    if (this.runStatusValue === undefined) {
      return;
    }
    this.runStatusValue.phase = phase;
    this.runStatusValue.toolName = toolName;
    this.sink.stateChanged();
  }

  private recordReasoning(delta: string): void {
    if (this.runStatusValue === undefined) {
      return;
    }
    if (this.runStatusValue.phase === "preparing") {
      this.runStatusValue.phase = "thinking";
    }
    this.runStatusValue.reasoningTokens += estimateDeltaTokens(delta);
    this.runStatusValue.thought = tailSnippet(
      (this.runStatusValue.thought ?? "") + delta
    );
    this.scheduleProgressStateChanged();
  }

  private recordOutput(delta: string): void {
    if (this.runStatusValue === undefined) {
      return;
    }
    this.runStatusValue.phase = "responding";
    this.runStatusValue.outputTokens += estimateDeltaTokens(delta);
    this.scheduleProgressStateChanged();
  }

  public async run(
    userText: string,
    mode: AgentMode,
    reuseLastUserMessage = false
  ): Promise<void> {
    if (this.running) {
      throw new Error("An agent request is already running.");
    }
    const trimmed = userText.trim();
    if (trimmed.length === 0) {
      throw new Error("Enter a task before starting the agent.");
    }

    this.running = true;
    this.abortController = new AbortController();
    this.activityById.clear();
    this.runStatusValue = {
      phase: "preparing",
      startedAt: new Date().toISOString(),
      reasoningTokens: 0,
      outputTokens: 0
    };
    const signal = this.abortController.signal;
    this.sink.stateChanged();
    this.audit.record("agent.request.started", {
      conversationId: this.conversations.active.id,
      mode,
      promptCharacters: trimmed.length
    });

    try {
      await this.conversations.setMode(mode);
      if (!reuseLastUserMessage) {
        await this.conversations.addDisplayMessage(
          "user",
          trimmed,
          "complete"
        );
        await this.conversations.appendModelMessage({
          role: "user",
          content: trimmed
        });
      }
      this.sink.stateChanged();
      await this.executeLoop(mode, signal);
      this.audit.record("agent.request.completed", {
        conversationId: this.conversations.active.id,
        mode
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        await this.markStreamingMessages("cancelled");
        this.sink.notice("info", "Generation stopped.");
        this.audit.record("agent.request.cancelled", {
          conversationId: this.conversations.active.id,
          mode
        });
      } else {
        await this.markStreamingMessages("failed");
        this.sink.notice(
          "error",
          error instanceof Error ? error.message : String(error)
        );
        this.audit.record("agent.request.failed", {
          conversationId: this.conversations.active.id,
          mode,
          errorType: error instanceof Error ? error.name : "UnknownError"
        });
      }
    } finally {
      if (this.progressStateTimer !== undefined) {
        clearTimeout(this.progressStateTimer);
        this.progressStateTimer = undefined;
      }
      this.runStatusValue = undefined;
      this.running = false;
      this.abortController = undefined;
      this.sink.stateChanged();
    }
  }

  public stop(): void {
    this.abortController?.abort();
  }

  private async executeLoop(
    mode: AgentMode,
    signal: AbortSignal
  ): Promise<void> {
    const config = this.readConfig();
    const repositoryContext = await this.repositoryContext.build(signal);
    let changedSinceVerification = false;
    let verificationNudges = 0;

    for (
      let iteration = 0;
      iteration < config.maxIterations;
      iteration += 1
    ) {
      const systemPrompt = buildSystemPrompt(mode);
      const fixedMessages: ModelMessage[] = [
        {
          role: "system",
          content:
            repositoryContext.trim().length === 0
              ? systemPrompt
              : `${systemPrompt}\n\n${repositoryContext}`
        }
      ];
      const combined = [
        ...fixedMessages,
        ...this.conversations.active.modelMessages
      ];
      const prepared = await this.contextManager.prepare(combined, signal);
      if (prepared.compacted) {
        await this.conversations.replaceModelMessages(
          prepared.messages.slice(fixedMessages.length)
        );
      }

      const display = await this.conversations.addDisplayMessage(
        "assistant",
        "",
        "streaming"
      );
      this.setPhase("preparing");
      this.sink.stateChanged();
      let emittedText = false;
      const response = await this.requestModelWithRetry(
        prepared.messages,
        signal,
        config,
        (delta) => {
          emittedText = true;
          this.recordOutput(delta);
          void this.conversations.appendDisplayContent(display.id, delta);
          this.sink.assistantDelta(display.id, delta);
        },
        (delta) => {
          this.recordReasoning(delta);
          this.sink.assistantReasoningDelta(display.id, delta);
        },
        () => emittedText
      );
      if (!emittedText && response.content.length > 0) {
        await this.conversations.appendDisplayContent(
          display.id,
          response.content
        );
        this.sink.assistantDelta(display.id, response.content);
      }

      await this.conversations.appendModelMessage({
        role: "assistant",
        content: response.content,
        toolCalls:
          response.toolCalls.length === 0 ? undefined : response.toolCalls,
        reasoningContent:
          response.reasoningContent.length === 0
            ? undefined
            : response.reasoningContent
      });
      await this.conversations.updateUsage(response.usage);

      if (response.content.length === 0 && response.toolCalls.length > 0) {
        await this.conversations.removeDisplayMessage(display.id);
      } else {
        await this.conversations.setDisplayState(display.id, "complete");
      }
      this.sink.stateChanged();

      if (response.toolCalls.length === 0) {
        if (
          mode === "agent" &&
          changedSinceVerification &&
          verificationNudges < 1
        ) {
          verificationNudges += 1;
          await this.conversations.appendModelMessage({
            role: "user",
            content:
              "You changed repository files but have not run a relevant successful verification command afterward. If an existing test, build, type-check, or lint command can verify the change, run the smallest relevant one now. Otherwise, explicitly explain why verification is unavailable."
          });
          continue;
        }
        if (mode === "agent" && changedSinceVerification) {
          this.sink.notice(
            "warning",
            "The agent changed files without a successful post-change verification command."
          );
        }
        return;
      }

      for (
        let callIndex = 0;
        callIndex < response.toolCalls.length;
        callIndex += 1
      ) {
        const call = response.toolCalls[callIndex]!;
        this.setPhase("tool", call.function.name);
        try {
          const outcome = await this.executeTool(call, mode, signal);
          await this.conversations.appendModelMessage({
            role: "tool",
            name: call.function.name,
            toolCallId: call.id,
            content: outcome.content
          });
          if (
            !outcome.isError &&
            isWriteTool(call.function.name) &&
            outcome.content.includes('"state": "applied"')
          ) {
            changedSinceVerification = true;
          }
          if (
            !outcome.isError &&
            call.function.name === "run_command" &&
            isSuccessfulVerificationCall(call, outcome.content)
          ) {
            changedSinceVerification = false;
          }
        } catch (error) {
          if (signal.aborted || isAbortError(error)) {
            await this.appendCancelledToolResults(
              response.toolCalls.slice(callIndex)
            );
          }
          throw error;
        }
      }
      this.sink.stateChanged();
    }

    throw new Error(
      `Agent stopped after reaching the ${config.maxIterations}-iteration limit.`
    );
  }

  private async requestModelWithRetry(
    messages: ModelMessage[],
    signal: AbortSignal,
    config: AgentRunConfiguration,
    onTextDelta: (delta: string) => void,
    onReasoningDelta: (delta: string) => void,
    hasEmittedText: () => boolean
  ): Promise<ModelResponse> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= config.maxModelRetries;
      attempt += 1
    ) {
      try {
        return await this.model.streamChat(
          {
            messages,
            tools: this.tools.definitions,
            maxTokens: config.maxOutputTokens,
            temperature: config.temperature,
            topP: config.topP,
            topK: config.topK,
            enableThinking: config.enableThinking,
            preserveThinking: config.preserveThinking,
            signal
          },
          { onTextDelta, onReasoningDelta }
        );
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          throw error;
        }
        lastError = error;
        if (hasEmittedText() || attempt === config.maxModelRetries) {
          break;
        }
        this.sink.notice(
          "warning",
          `Model request failed; retrying (${attempt + 1}/${config.maxModelRetries}).`
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Model request failed.");
  }

  private async executeTool(
    call: ModelToolCall,
    mode: AgentMode,
    signal: AbortSignal
  ) {
    const activity: ToolActivity = {
      id: randomUUID(),
      name: call.function.name,
      summary: `Running ${call.function.name}`,
      state: "running",
      startedAt: new Date().toISOString()
    };
    this.activityById.set(activity.id, activity);
    this.audit.record("tool.started", {
      activityId: activity.id,
      tool: call.function.name,
      mode
    });
    this.sink.stateChanged();

    try {
      const context = this.createToolContext(mode, signal, (detail) => {
        activity.detail = detail;
        this.scheduleProgressStateChanged();
      });
      const outcome = await this.tools.execute(call, context);
      activity.state = outcome.isError ? "failed" : "succeeded";
      activity.summary = outcome.summary;
      activity.completedAt = new Date().toISOString();
      this.audit.record("tool.completed", {
        activityId: activity.id,
        tool: call.function.name,
        succeeded: !outcome.isError
      });
      this.sink.stateChanged();
      return outcome;
    } catch (error) {
      activity.state = isAbortError(error) ? "cancelled" : "failed";
      activity.summary =
        error instanceof Error ? error.message : String(error);
      activity.completedAt = new Date().toISOString();
      this.audit.record("tool.failed", {
        activityId: activity.id,
        tool: call.function.name,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
      this.sink.stateChanged();
      throw error;
    }
  }

  private scheduleProgressStateChanged(): void {
    if (this.progressStateTimer !== undefined) {
      return;
    }
    this.progressStateTimer = setTimeout(() => {
      this.progressStateTimer = undefined;
      this.sink.stateChanged();
    }, 100);
  }

  private async appendCancelledToolResults(
    calls: readonly ModelToolCall[]
  ): Promise<void> {
    for (const call of calls) {
      await this.conversations.appendModelMessage({
        role: "tool",
        name: call.function.name,
        toolCallId: call.id,
        content: JSON.stringify({
          error: "Tool execution was cancelled by the user."
        })
      });
    }
  }

  private async markStreamingMessages(
    state: "failed" | "cancelled"
  ): Promise<void> {
    const streaming = this.conversations.active.displayMessages.filter(
      (message) => message.state === "streaming"
    );
    await Promise.all(
      streaming.map((message) =>
        this.conversations.setDisplayState(message.id, state)
      )
    );
  }
}

function isWriteTool(name: string): boolean {
  return new Set([
    "create_file",
    "edit_file",
    "delete_file",
    "apply_patch",
    "format_document"
  ]).has(name);
}

function isSuccessfulVerificationCall(
  call: ModelToolCall,
  resultContent: string
): boolean {
  if (!resultContent.includes('"exitCode": 0')) {
    return false;
  }
  try {
    const args = JSON.parse(call.function.arguments) as {
      command?: unknown;
    };
    return (
      typeof args.command === "string" &&
      /\b(test|build|compile|check|lint|verify|typecheck|xcodebuild|gradle)\b/i.test(
        args.command
      )
    );
  } catch {
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function estimateDeltaTokens(delta: string): number {
  return Math.max(1, Math.ceil(delta.length / 4));
}

function tailSnippet(text: string, maxLength = 180): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxLength
    ? collapsed
    : `…${collapsed.slice(collapsed.length - maxLength)}`;
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimated: left.estimated || right.estimated
  };
}
