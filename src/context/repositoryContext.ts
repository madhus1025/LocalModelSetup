import type { GitService } from "../git/gitService";
import type { WorkspaceService } from "../workspace/types";

export interface RepositoryContextSource {
  build(signal: AbortSignal): Promise<string>;
}

export class RepositoryContextBuilder implements RepositoryContextSource {
  public constructor(
    private readonly workspace: WorkspaceService,
    private readonly git: GitService
  ) {}

  public async build(signal: AbortSignal): Promise<string> {
    const [files, gitStatus, gitDiff] = await Promise.all([
      this.workspace.listFiles("**/*", 2_000),
      this.captureGit(() => this.git.status(signal)),
      this.captureGit(() => this.git.diff(signal))
    ]);
    const editor = this.workspace.getEditorSnapshot();
    const diagnostics = this.workspace.getDiagnostics(100);
    const map = boundedFileMap(files, 14_000);
    const selection =
      editor.selection === undefined
        ? "No editor selection."
        : [
            `Selected lines ${editor.selection.startLine}-${editor.selection.endLine}:`,
            fenced(editor.selection.text, 8_000)
          ].join("\n");

    return [
      "# Current repository context",
      "",
      `Workspace roots: ${this.workspace.roots.join(", ")}`,
      `Active file: ${editor.activeFile ?? "none"}`,
      `Open files: ${editor.openFiles.join(", ") || "none"}`,
      `Recently used files: ${editor.recentFiles.join(", ") || "none"}`,
      "",
      selection,
      "",
      "## Repository map",
      map,
      "",
      "## Git status",
      bounded(gitStatus, 6_000),
      "",
      "## Current unstaged diff",
      bounded(gitDiff, 8_000),
      "",
      "## Diagnostics",
      diagnostics.length === 0
        ? "No current workspace diagnostics."
        : diagnostics
            .map(
              (diagnostic) =>
                `${diagnostic.severity.toUpperCase()} ${diagnostic.path}:${diagnostic.line} ${diagnostic.message}`
            )
            .join("\n")
    ].join("\n");
  }

  private async captureGit(operation: () => Promise<string>): Promise<string> {
    try {
      const output = await operation();
      return output.trim().length === 0 ? "(clean or no output)" : output;
    } catch (error) {
      return `[Git context unavailable: ${
        error instanceof Error ? error.message : String(error)
      }]`;
    }
  }
}

function boundedFileMap(files: string[], maxCharacters: number): string {
  const joined = files.join("\n");
  if (joined.length <= maxCharacters) {
    return joined;
  }
  const visible = joined.slice(0, maxCharacters);
  const shown = visible.split("\n").length;
  return `${visible}\n[repository map truncated: showing ${shown} of ${files.length} files]`;
}

function bounded(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return `${value.slice(0, maxCharacters)}\n[context truncated; use a focused tool call for the remainder]`;
}

function fenced(value: string, maxCharacters: number): string {
  return `\`\`\`\n${bounded(value, maxCharacters)}\n\`\`\``;
}
