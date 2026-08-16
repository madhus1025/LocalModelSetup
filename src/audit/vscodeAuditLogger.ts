import { promises as fs } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { AuditSink } from "./types";

export class VscodeAuditLogger implements AuditSink {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(
    globalStorageUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.filePath = path.join(globalStorageUri.fsPath, "audit.jsonl");
  }

  public record(
    event: string,
    data: Record<string, string | number | boolean | string[] | null>
  ): void {
    const line = `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...data
    })}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, line, { encoding: "utf8" });
      })
      .catch((error: unknown) => {
        this.output.appendLine(
          `Audit write failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  }

  public async open(): Promise<void> {
    await this.writeQueue;
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, "", { encoding: "utf8" });
    }
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(this.filePath)
    );
    await vscode.window.showTextDocument(document, { preview: false });
  }
}
