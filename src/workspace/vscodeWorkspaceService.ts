import path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceBoundary } from "../security/workspaceBoundary";
import { applyTextRangeEdits } from "./textEdits";
import type {
  DiagnosticSummary,
  EditorSnapshot,
  SymbolMatch,
  TextDocumentSnapshot,
  TextSearchMatch,
  TextSearchRequest,
  WorkspaceFileChange,
  WorkspaceService
} from "./types";

const defaultExclusion =
  "**/{.git,node_modules,dist,out,build,coverage,.next,.cache,DerivedData,.ssh,.aws,.azure,.gnupg}/**";
const sensitiveFileExclusion =
  "**/{.env,.env.*,*.pem,*.p12,*.key,.git-credentials,.netrc,.npmrc,.pypirc}";
const searchExclusions = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.cache/**",
  "**/DerivedData/**",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.azure/**",
  "**/.gnupg/**",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.p12",
  "**/*.key",
  "**/.git-credentials",
  "**/.netrc",
  "**/.npmrc",
  "**/.pypirc"
];

export class VscodeWorkspaceService
  implements WorkspaceService, vscode.Disposable
{
  private readonly disposables: vscode.Disposable[] = [];
  private readonly recentFiles: string[] = [];

  public constructor(private readonly boundary: WorkspaceBoundary) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor !== undefined) {
          this.track(editor.document.uri);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.track(event.document.uri);
      })
    );
  }

  public get roots(): readonly string[] {
    return this.boundary.roots;
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  public async listFiles(
    pattern: string,
    maxResults: number
  ): Promise<string[]> {
    const results: string[] = [];
    for (const root of this.roots) {
      if (results.length >= maxResults) {
        break;
      }
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, pattern),
        defaultExclusion,
        maxResults - results.length
      );
      results.push(
        ...uris
          .filter((uri) => uri.scheme === "file")
          .map((uri) => this.boundary.displayPath(uri.fsPath))
      );
    }
    return [...new Set(results)].sort();
  }

  public async readText(inputPath: string): Promise<TextDocumentSnapshot> {
    const absolutePath = await this.boundary.resolveForRead(inputPath);
    const existingDocument = vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.scheme === "file" &&
        path.resolve(document.uri.fsPath) === absolutePath
    );
    const document =
      existingDocument ??
      (await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath)));
    return {
      path: this.boundary.displayPath(absolutePath),
      content: document.getText(),
      version: document.version
    };
  }

  public async exists(inputPath: string): Promise<boolean> {
    try {
      await this.boundary.resolveForRead(inputPath);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("does not exist") ||
          error.message.includes("ENOENT"))
      ) {
        return false;
      }
      throw error;
    }
  }

  public async writeText(inputPath: string, content: string): Promise<void> {
    const absolutePath = await this.boundary.resolveForWrite(inputPath);
    const uri = vscode.Uri.file(absolutePath);
    const edit = new vscode.WorkspaceEdit();

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const lastLine = document.lineAt(document.lineCount - 1);
      edit.replace(
        uri,
        new vscode.Range(
          new vscode.Position(0, 0),
          lastLine.rangeIncludingLineBreak.end
        ),
        content
      );
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
      edit.createFile(uri, {
        ignoreIfExists: false,
        overwrite: false
      });
      edit.insert(uri, new vscode.Position(0, 0), content);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`VS Code rejected the edit for ${inputPath}.`);
    }
    await saveDocuments([uri]);
  }

  public async deleteFile(inputPath: string): Promise<void> {
    const absolutePath = await this.boundary.resolveForRead(inputPath);
    const openDocument = vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.scheme === "file" &&
        path.resolve(document.uri.fsPath) === absolutePath
    );
    if (openDocument?.isDirty === true) {
      throw new Error(
        `Cannot delete ${inputPath} because it has unsaved editor changes.`
      );
    }
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(vscode.Uri.file(absolutePath), {
      ignoreIfNotExists: false,
      recursive: false
    });
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error(`VS Code rejected deletion of ${inputPath}.`);
    }
  }

  public async applyChanges(
    changes: WorkspaceFileChange[]
  ): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    for (const change of changes) {
      const absolutePath = change.delete
        ? await this.boundary.resolveForRead(change.path)
        : await this.boundary.resolveForWrite(change.path);
      const uri = vscode.Uri.file(absolutePath);
      if (change.delete) {
        const openDocument = vscode.workspace.textDocuments.find(
          (document) =>
            document.uri.scheme === "file" &&
            path.resolve(document.uri.fsPath) === absolutePath
        );
        if (openDocument?.isDirty === true) {
          throw new Error(
            `Cannot delete ${change.path} because it has unsaved editor changes.`
          );
        }
        edit.deleteFile(uri, {
          ignoreIfNotExists: false,
          recursive: false
        });
        continue;
      }
      if (change.content === undefined) {
        throw new TypeError(`Change for ${change.path} has no content.`);
      }
      if (change.create) {
        edit.createFile(uri, {
          ignoreIfExists: false,
          overwrite: false
        });
        edit.insert(uri, new vscode.Position(0, 0), change.content);
        continue;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const lastLine = document.lineAt(document.lineCount - 1);
        edit.replace(
          uri,
          new vscode.Range(
            new vscode.Position(0, 0),
            lastLine.rangeIncludingLineBreak.end
          ),
          change.content
        );
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          throw error;
        }
        edit.createFile(uri, {
          ignoreIfExists: false,
          overwrite: false
        });
        edit.insert(uri, new vscode.Position(0, 0), change.content);
      }
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error("VS Code rejected the multi-file workspace edit.");
    }
    await saveDocuments(
      changes
        .filter((change) => !change.delete)
        .map(async (change) =>
          vscode.Uri.file(
            await this.boundary.resolveForRead(change.path)
          )
        )
    );
  }

  public async searchText(
    request: TextSearchRequest
  ): Promise<TextSearchMatch[]> {
    const matcher = createTextMatcher(request);
    const matches: TextSearchMatch[] = [];
    const include = request.include ?? "**/*";
    const exclusion = combineExclusions(request.exclude);

    for (const root of this.roots) {
      if (matches.length >= request.maxResults) {
        break;
      }
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, include),
        exclusion,
        10_000
      );
      for (let offset = 0; offset < uris.length; offset += 24) {
        if (matches.length >= request.maxResults) {
          break;
        }
        const batch = uris.slice(offset, offset + 24);
        const batchMatches = await Promise.all(
          batch.map((uri) =>
            this.searchFile(uri, matcher, request.maxResults)
          )
        );
        for (const fileMatches of batchMatches) {
          matches.push(...fileMatches);
          if (matches.length >= request.maxResults) {
            break;
          }
        }
      }
    }
    return matches.slice(0, request.maxResults);
  }

  public async findSymbols(
    query: string,
    maxResults: number
  ): Promise<SymbolMatch[]> {
    const symbols =
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        query
      )) ?? [];
    return symbols
      .filter(
        (symbol) =>
          symbol.location.uri.scheme === "file" &&
          this.boundary.contains(symbol.location.uri.fsPath)
      )
      .slice(0, maxResults)
      .map((symbol) => ({
        name: symbol.name,
        kind: vscode.SymbolKind[symbol.kind] ?? String(symbol.kind),
        path: this.boundary.displayPath(symbol.location.uri.fsPath),
        line: symbol.location.range.start.line + 1,
        ...(symbol.containerName.length === 0
          ? {}
          : { container: symbol.containerName })
      }));
  }

  public getDiagnostics(maxResults: number): DiagnosticSummary[] {
    const results: DiagnosticSummary[] = [];
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (
        uri.scheme !== "file" ||
        !this.boundary.contains(uri.fsPath) ||
        results.length >= maxResults
      ) {
        continue;
      }
      for (const diagnostic of diagnostics) {
        if (results.length >= maxResults) {
          break;
        }
        results.push({
          path: this.boundary.displayPath(uri.fsPath),
          line: diagnostic.range.start.line + 1,
          severity: diagnosticSeverity(diagnostic.severity),
          message: diagnostic.message,
          ...(diagnostic.source === undefined
            ? {}
            : { source: diagnostic.source }),
          ...(diagnostic.code === undefined
            ? {}
            : {
                code:
                  typeof diagnostic.code === "object"
                    ? String(diagnostic.code.value)
                    : String(diagnostic.code)
              })
        });
      }
    }
    return results;
  }

  public getEditorSnapshot(): EditorSnapshot {
    const active = vscode.window.activeTextEditor;
    const activeFile =
      active !== undefined &&
      active.document.uri.scheme === "file" &&
      this.boundary.contains(active.document.uri.fsPath)
        ? this.boundary.displayPath(active.document.uri.fsPath)
        : undefined;
    const selection =
      active !== undefined &&
      activeFile !== undefined &&
      !active.selection.isEmpty
        ? {
            startLine: active.selection.start.line + 1,
            endLine: active.selection.end.line + 1,
            text: active.document.getText(active.selection)
          }
        : undefined;
    const openFiles = vscode.workspace.textDocuments
      .filter(
        (document) =>
          document.uri.scheme === "file" &&
          this.boundary.contains(document.uri.fsPath)
      )
      .map((document) => this.boundary.displayPath(document.uri.fsPath));

    return {
      ...(activeFile === undefined ? {} : { activeFile }),
      ...(selection === undefined ? {} : { selection }),
      openFiles: [...new Set(openFiles)],
      recentFiles: [...this.recentFiles]
    };
  }

  public async getFormattedText(inputPath: string): Promise<string> {
    const snapshot = await this.readText(inputPath);
    const absolutePath = await this.boundary.resolveForRead(inputPath);
    const edits =
      (await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        vscode.Uri.file(absolutePath),
        {
          tabSize: 2,
          insertSpaces: true
        }
      )) ?? [];
    return applyTextRangeEdits(
      snapshot.content,
      edits.map((edit) => ({
        startLine: edit.range.start.line + 1,
        startColumn: edit.range.start.character + 1,
        endLine: edit.range.end.line + 1,
        endColumn: edit.range.end.character + 1,
        text: edit.newText
      }))
    );
  }

  public async reveal(inputPath: string, line?: number): Promise<void> {
    const absolutePath = await this.boundary.resolveForRead(inputPath);
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(absolutePath)
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: false
    });
    if (line !== undefined) {
      const targetLine = Math.max(0, Math.min(document.lineCount - 1, line - 1));
      const position = new vscode.Position(targetLine, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );
    }
  }

  public toAbsolutePath(
    inputPath: string,
    forWrite = false
  ): Promise<string> {
    return forWrite
      ? this.boundary.resolveForWrite(inputPath)
      : this.boundary.resolveForRead(inputPath);
  }

  public toDisplayPath(absolutePath: string): string {
    return this.boundary.displayPath(absolutePath);
  }

  private track(uri: vscode.Uri): void {
    if (uri.scheme !== "file" || !this.boundary.contains(uri.fsPath)) {
      return;
    }
    const displayPath = this.boundary.displayPath(uri.fsPath);
    const existing = this.recentFiles.indexOf(displayPath);
    if (existing >= 0) {
      this.recentFiles.splice(existing, 1);
    }
    this.recentFiles.unshift(displayPath);
    this.recentFiles.splice(12);
  }

  private async searchFile(
    uri: vscode.Uri,
    matcher: RegExp,
    maxResults: number
  ): Promise<TextSearchMatch[]> {
    if (uri.scheme !== "file") {
      return [];
    }
    let absolutePath: string;
    try {
      absolutePath = await this.boundary.resolveForRead(uri.fsPath);
    } catch {
      return [];
    }
    const openDocument = vscode.workspace.textDocuments.find(
      (document) =>
        document.uri.scheme === "file" &&
        path.resolve(document.uri.fsPath) === absolutePath
    );
    const content =
      openDocument?.getText() ??
      (await readBoundedWorkspaceFile(vscode.Uri.file(absolutePath)));
    if (content === undefined) {
      return [];
    }
    const results: TextSearchMatch[] = [];
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      matcher.lastIndex = 0;
      if (matcher.test(lines[index]!)) {
        results.push({
          path: this.boundary.displayPath(absolutePath),
          line: index + 1,
          preview: lines[index]!.trim().slice(0, 500)
        });
        if (results.length >= maxResults) {
          break;
        }
      }
    }
    return results;
  }
}

function diagnosticSeverity(
  severity: vscode.DiagnosticSeverity
): DiagnosticSummary["severity"] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("FileNotFound") ||
      error.message.includes("ENOENT") ||
      error.name === "EntryNotFound")
  );
}

function createTextMatcher(request: TextSearchRequest): RegExp {
  const source = request.isRegex
    ? request.query
    : request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, request.isCaseSensitive ? "g" : "gi");
  } catch (error) {
    throw new Error(
      `Invalid search expression: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function combineExclusions(custom: string | undefined): string {
  const values = [...searchExclusions];
  if (custom !== undefined && custom.trim().length > 0) {
    values.push(custom);
  }
  return `{${values.join(",")}}`;
}

async function readBoundedWorkspaceFile(
  uri: vscode.Uri
): Promise<string | undefined> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > 2_000_000) {
    return undefined;
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.includes(0)) {
    return undefined;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

async function saveDocuments(
  uris:
    | vscode.Uri[]
    | Array<Promise<vscode.Uri>>
): Promise<void> {
  const resolvedUris = await Promise.all(uris);
  const outcomes = await Promise.all(
    resolvedUris.map(async (uri) => {
      const document = await vscode.workspace.openTextDocument(uri);
      return {
        path: uri.fsPath,
        saved: await document.save()
      };
    })
  );
  const failed = outcomes.filter((outcome) => !outcome.saved);
  if (failed.length > 0) {
    throw new Error(
      `VS Code could not save: ${failed.map((outcome) => outcome.path).join(", ")}`
    );
  }
}
