import * as vscode from "vscode";
import type { ChangeCoordinator } from "./changeCoordinator";

const scheme = "local-coding-agent-diff";

export class ReviewDiffProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly registration: vscode.Disposable;

  public readonly onDidChange = this.emitter.event;

  public constructor(private readonly coordinator: ChangeCoordinator) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      scheme,
      this
    );
  }

  public dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const query = new URLSearchParams(uri.query);
    const reviewId = query.get("reviewId");
    const filePath = query.get("path");
    const side = query.get("side");
    if (reviewId === null || filePath === null) {
      return "Diff content is unavailable.";
    }
    const changeSet = this.coordinator.getChangeSet(reviewId);
    const file = changeSet?.files.find((candidate) => candidate.path === filePath);
    if (file === undefined) {
      return "Diff content is unavailable.";
    }
    return side === "proposed" ? file.proposedContent : file.baseContent;
  }

  public async open(reviewId: string, filePath: string): Promise<void> {
    const encodedPath = encodeURIComponent(filePath);
    const original = vscode.Uri.from({
      scheme,
      path: `/${encodedPath}.original`,
      query: new URLSearchParams({
        reviewId,
        path: filePath,
        side: "original"
      }).toString()
    });
    const proposed = vscode.Uri.from({
      scheme,
      path: `/${encodedPath}.proposed`,
      query: new URLSearchParams({
        reviewId,
        path: filePath,
        side: "proposed"
      }).toString()
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      original,
      proposed,
      `Local Agent: ${filePath}`,
      { preview: true }
    );
  }
}
