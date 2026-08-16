import os from "node:os";
import type { ApprovalManager } from "../security/approval";
import {
  CommandPolicy,
  type CommandAssessment
} from "../security/commandPolicy";
import {
  sanitizeEnvironment,
  SecretRedactor
} from "../security/redaction";
import type { ProcessResult } from "./processRunner";
import { ProcessRunner } from "./processRunner";

export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  maxOutputCharacters: number;
  signal: AbortSignal;
  onOutput?(stream: "stdout" | "stderr", text: string): void;
}

export class CommandRunner {
  private readonly policy = new CommandPolicy();
  private readonly processRunner = new ProcessRunner();

  public constructor(private readonly approvals: ApprovalManager) {}

  public async run(request: CommandRequest): Promise<ProcessResult> {
    const assessment = this.policy.assess(request.command);
    await this.enforceAssessment(request.command, assessment, request.signal);

    const sanitized = sanitizeEnvironment(process.env);
    const redactor = new SecretRedactor(sanitized.removedValues);
    const shell =
      os.platform() === "win32"
        ? { executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] }
        : { executable: process.env.SHELL ?? "/bin/zsh", args: ["-lc"] };

    return this.processRunner.run({
      executable: shell.executable,
      args: [...shell.args, request.command],
      cwd: request.cwd,
      environment: sanitized.environment,
      timeoutMs: request.timeoutSeconds * 1_000,
      maxOutputCharacters: request.maxOutputCharacters,
      signal: request.signal,
      redactor,
      onOutput: request.onOutput
    });
  }

  private async enforceAssessment(
    command: string,
    assessment: CommandAssessment,
    signal: AbortSignal
  ): Promise<void> {
    if (assessment.decision === "deny") {
      throw new Error(assessment.reasons.join(" "));
    }
    if (assessment.decision === "allow") {
      return;
    }
    const allowed = await this.approvals.request(
      "Approve terminal command",
      command,
      assessment.reasons,
      assessment.severity,
      signal
    );
    if (!allowed) {
      throw new Error("The terminal command was rejected by the user.");
    }
  }
}
