import { describe, expect, it, vi } from "vitest";
import type { ModelToolCall } from "../llm/types";
import type { WorkspaceService } from "../workspace/types";
import { createFileTools } from "./fileTools";
import { ToolRegistry } from "./registry";
import type { ToolExecutionContext } from "./types";

function fakeWorkspace(): WorkspaceService {
  return {
    roots: ["/workspace"],
    listFiles: vi.fn(async () => ["src/example.ts"]),
    readText: vi.fn(async (path: string) => ({
      path,
      content: "export const value = 42;\n",
      version: 1
    })),
    exists: vi.fn(async () => true),
    writeText: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    applyChanges: vi.fn(async () => undefined),
    searchText: vi.fn(async () => []),
    findSymbols: vi.fn(async () => []),
    getDiagnostics: vi.fn(() => []),
    getEditorSnapshot: vi.fn(() => ({
      openFiles: [],
      recentFiles: []
    })),
    getFormattedText: vi.fn(async () => ""),
    reveal: vi.fn(async () => undefined),
    toAbsolutePath: vi.fn(async (path: string) => `/workspace/${path}`),
    toDisplayPath: vi.fn((path: string) => path)
  };
}

function context(mode: ToolExecutionContext["mode"]): ToolExecutionContext {
  return {
    mode,
    workspace: fakeWorkspace(),
    changes: {
      propose: vi.fn(async () => ({
        changeSetId: "change",
        state: "applied" as const,
        changedFiles: []
      }))
    },
    git: {
      status: vi.fn(async () => ""),
      diff: vi.fn(async () => ""),
      log: vi.fn(async () => ""),
      blame: vi.fn(async () => ""),
      inspectCommit: vi.fn(async () => "")
    },
    commands: {
      run: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        truncated: false
      }))
    },
    autoApplySafeEdits: false,
    commandTimeoutSeconds: 30,
    maxToolOutputCharacters: 30_000,
    signal: new AbortController().signal,
    onProgress: vi.fn()
  };
}

function call(name: string, argumentsValue: object): ModelToolCall {
  return {
    id: "call",
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(argumentsValue)
    }
  };
}

describe("file tools", () => {
  it("reads workspace text through the bounded workspace service", async () => {
    const registry = new ToolRegistry(createFileTools());
    const result = await registry.execute(
      call("read_file", { path: "src/example.ts" }),
      context("ask")
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("export const value = 42");
  });

  it("blocks write tools in Ask mode before proposing a change", async () => {
    const registry = new ToolRegistry(createFileTools());
    const executionContext = context("ask");
    const result = await registry.execute(
      call("create_file", { path: "new.ts", content: "content" }),
      executionContext
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable in Ask mode");
    expect(executionContext.changes.propose).not.toHaveBeenCalled();
  });
});
