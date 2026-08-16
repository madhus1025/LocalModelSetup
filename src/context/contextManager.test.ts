import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "../llm/types";
import { ContextManager } from "./contextManager";

describe("ContextManager", () => {
  it("compacts older messages and keeps recent turns", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "stable instructions" },
      ...Array.from({ length: 20 }, (_, index): ModelMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(1_000)}`
      }))
    ];
    const summarize = vi.fn(async () => "Preserved decisions and modified files.");
    const notices: string[] = [];
    const manager = new ContextManager(
      4_000,
      500,
      { summarize },
      (notice) => notices.push(notice)
    );

    const prepared = await manager.prepare(
      messages,
      new AbortController().signal
    );

    expect(prepared.compacted).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
    expect(prepared.messages.at(-1)?.content).toContain("message-19");
    expect(prepared.messages.some((message) =>
      message.content.includes("Conversation memory")
    )).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it("does not silently remove an oversized recent request", async () => {
    const manager = new ContextManager(
      1_000,
      200,
      { summarize: vi.fn() },
      vi.fn()
    );

    await expect(
      manager.prepare(
        [{ role: "user", content: "x".repeat(10_000) }],
        new AbortController().signal
      )
    ).rejects.toThrow("exceeding");
  });

  it("retains the assistant parent when the window begins in tool results", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "stable instructions" },
      { role: "user", content: `old ${"x".repeat(2_000)}` },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: "{}" }
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "git_status", arguments: "{}" }
          }
        ]
      },
      {
        role: "tool",
        toolCallId: "call-1",
        name: "read_file",
        content: `first ${"y".repeat(1_000)}`
      },
      {
        role: "tool",
        toolCallId: "call-2",
        name: "git_status",
        content: `second ${"z".repeat(1_000)}`
      },
      ...Array.from({ length: 10 }, (_, index): ModelMessage => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `recent-${index} ${"r".repeat(500)}`
      }))
    ];
    const manager = new ContextManager(
      4_000,
      500,
      { summarize: vi.fn(async () => "old request summary") },
      vi.fn()
    );

    const prepared = await manager.prepare(
      messages,
      new AbortController().signal
    );
    const firstToolIndex = prepared.messages.findIndex(
      (message) => message.role === "tool"
    );

    expect(firstToolIndex).toBeGreaterThan(0);
    expect(prepared.messages[firstToolIndex - 1]?.role).toBe("assistant");
    expect(
      prepared.messages[firstToolIndex - 1]?.toolCalls?.map((call) => call.id)
    ).toContain("call-1");
  });
});
