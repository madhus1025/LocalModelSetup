import { spawn } from "node:child_process";
import os from "node:os";
import type { SecretRedactor } from "../security/redaction";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputCharacters: number;
  signal: AbortSignal;
  redactor: SecretRedactor;
  onOutput?(stream: "stdout" | "stderr", text: string): void;
}

export class ProcessRunner {
  public run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.signal.aborted) {
      return Promise.reject(
        new DOMException("Command execution was cancelled.", "AbortError")
      );
    }

    return new Promise<ProcessResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        env: request.environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: os.platform() !== "win32"
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      let timedOut = false;
      let forcedTermination: NodeJS.Timeout | undefined;

      const capture = (
        stream: "stdout" | "stderr",
        chunk: Buffer
      ): void => {
        const redacted = request.redactor.redact(chunk.toString("utf8"));
        request.onOutput?.(stream, redacted);
        if (truncated) {
          return;
        }
        if (stream === "stdout") {
          const captured = appendWithinLimit(
            stdout,
            redacted,
            request.maxOutputCharacters
          );
          stdout = captured.text;
          truncated ||= captured.truncated;
        } else {
          const captured = appendWithinLimit(
            stderr,
            redacted,
            request.maxOutputCharacters
          );
          stderr = captured.text;
          truncated ||= captured.truncated;
        }
      };

      child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

      const terminate = (): void => {
        terminateProcessTree(child.pid, "SIGTERM");
        forcedTermination = setTimeout(
          () => terminateProcessTree(child.pid, "SIGKILL"),
          2_000
        );
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs);
      const abort = (): void => terminate();
      request.signal.addEventListener("abort", abort, { once: true });

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forcedTermination !== undefined) {
          clearTimeout(forcedTermination);
        }
        request.signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (forcedTermination !== undefined) {
          clearTimeout(forcedTermination);
        }
        request.signal.removeEventListener("abort", abort);
        if (request.signal.aborted) {
          reject(
            new DOMException("Command execution was cancelled.", "AbortError")
          );
          return;
        }
        if (timedOut) {
          reject(
            new Error(
              `Command timed out after ${Math.round(request.timeoutMs / 1_000)} seconds.`
            )
          );
          return;
        }
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          truncated
        });
      });
    });
  }

}

function terminateProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals
): void {
  if (pid === undefined) {
    return;
  }
  try {
    if (os.platform() === "win32") {
      const args = ["/pid", String(pid), "/T"];
      if (signal === "SIGKILL") {
        args.push("/F");
      }
      const killer = spawn("taskkill", args, {
        windowsHide: true,
        stdio: "ignore"
      });
      killer.on("error", () => undefined);
      killer.unref();
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    void error;
  }
}

function appendWithinLimit(
  current: string,
  addition: string,
  limit: number
): { text: string; truncated: boolean } {
  const remaining = Math.max(0, limit - current.length);
  if (addition.length <= remaining) {
    return { text: current + addition, truncated: false };
  }
  return {
    text: (
      current +
      addition.slice(0, remaining) +
      "\n[output truncated; run a narrower command for more detail]"
    ).slice(0, limit),
    truncated: true
  };
}
