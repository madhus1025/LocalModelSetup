import path from "node:path";
import { sanitizeEnvironment, SecretRedactor } from "../security/redaction";
import type { WorkspaceBoundary } from "../security/workspaceBoundary";
import { ProcessRunner } from "../terminal/processRunner";

export class GitService {
  private readonly runner = new ProcessRunner();

  public constructor(
    private readonly boundary: WorkspaceBoundary,
    private readonly maxOutputCharacters: number
  ) {}

  public async status(signal: AbortSignal): Promise<string> {
    return this.runAcrossRoots(["status", "--short", "--branch"], signal);
  }

  public async diff(
    signal: AbortSignal,
    staged = false,
    inputPath?: string
  ): Promise<string> {
    const args = ["diff", "--no-ext-diff", "--minimal"];
    if (staged) {
      args.push("--staged");
    }
    if (inputPath !== undefined) {
      const absolutePath = await this.boundary.resolveForRead(inputPath);
      const root = this.boundary.rootFor(absolutePath);
      args.push("--", path.relative(root, absolutePath));
      return this.run(args, signal, root);
    }
    return this.runAcrossRoots(args, signal);
  }

  public log(signal: AbortSignal, limit: number): Promise<string> {
    return this.run(
      [
        "log",
        `-${Math.max(1, Math.min(limit, 100))}`,
        "--date=iso-strict",
        "--format=%h%x09%ad%x09%an%x09%s"
      ],
      signal
    );
  }

  public async blame(
    signal: AbortSignal,
    inputPath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    const absolutePath = await this.boundary.resolveForRead(inputPath);
    const root = this.boundary.rootFor(absolutePath);
    const relativePath = path.relative(root, absolutePath);
    const args = ["blame", "--date=short"];
    if (startLine !== undefined) {
      const end = endLine ?? startLine;
      args.push("-L", `${startLine},${end}`);
    }
    args.push("--", relativePath);
    return this.run(args, signal, root);
  }

  public inspectCommit(signal: AbortSignal, revision: string): Promise<string> {
    if (!/^[A-Za-z0-9._/^~:-]+$/.test(revision)) {
      return Promise.reject(new Error("Revision contains unsupported characters."));
    }
    return this.run(
      [
        "show",
        "--no-ext-diff",
        "--format=fuller",
        "--stat",
        "--patch",
        revision
      ],
      signal
    );
  }

  private async runAcrossRoots(
    args: string[],
    signal: AbortSignal
  ): Promise<string> {
    const outputs = await Promise.all(
      this.boundary.roots.map(async (root) => {
        const output = await this.run(args, signal, root);
        return this.boundary.roots.length === 1
          ? output
          : `## ${path.basename(root)}\n${output}`;
      })
    );
    return outputs.join("\n");
  }

  private async run(
    args: string[],
    signal: AbortSignal,
    cwd = this.boundary.roots[0]!
  ): Promise<string> {
    const sanitized = sanitizeEnvironment(process.env);
    const result = await this.runner.run({
      executable: "git",
      args: ["--no-pager", ...args],
      cwd,
      environment: sanitized.environment,
      timeoutMs: 120_000,
      maxOutputCharacters: this.maxOutputCharacters,
      signal,
      redactor: new SecretRedactor(sanitized.removedValues)
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Git exited with code ${result.exitCode ?? "unknown"}: ${result.stderr.trim()}`
      );
    }
    return result.stdout;
  }
}
