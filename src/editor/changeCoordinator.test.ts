import { describe, expect, it, vi } from "vitest";
import type { WorkspaceService } from "../workspace/types";
import { ChangeCoordinator } from "./changeCoordinator";

function workspaceWithLateCreate(): WorkspaceService {
  return {
    roots: ["/workspace"],
    listFiles: vi.fn(async () => []),
    readText: vi.fn(async (path: string) => ({
      path,
      content: "independent content",
      version: 1
    })),
    exists: vi
      .fn<WorkspaceService["exists"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true),
    writeText: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    applyChanges: vi.fn(async () => undefined),
    searchText: vi.fn(async () => []),
    findSymbols: vi.fn(async () => []),
    getDiagnostics: vi.fn(() => []),
    getEditorSnapshot: vi.fn(() => ({ openFiles: [], recentFiles: [] })),
    getFormattedText: vi.fn(async () => ""),
    reveal: vi.fn(async () => undefined),
    toAbsolutePath: vi.fn(async (path: string) => `/workspace/${path}`),
    toDisplayPath: vi.fn((path: string) => path)
  };
}

describe("ChangeCoordinator", () => {
  it("rejects a create proposal when the path appears before application", async () => {
    const workspace = workspaceWithLateCreate();
    const coordinator = new ChangeCoordinator(workspace, {
      showChangeReview: vi.fn()
    });

    await expect(
      coordinator.propose(
        "Create file",
        [{ path: "new.ts", kind: "create", proposedContent: "agent content" }],
        "agent",
        true,
        new AbortController().signal
      )
    ).rejects.toThrow("was created after");
    expect(workspace.applyChanges).not.toHaveBeenCalled();
  });
});
