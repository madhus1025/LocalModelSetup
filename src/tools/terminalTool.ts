import {
  isRecord,
  optionalNumber,
  optionalString,
  requireString
} from "../shared/json";
import type { AgentTool } from "./types";

export function createTerminalTool(): AgentTool<{
  command: string;
  cwd: string;
  timeoutSeconds?: number;
}> {
  return {
    kind: "command",
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a non-interactive shell command in Agent mode. Destructive, privileged, network, publishing, credential, package-install, and Git state-changing commands require explicit approval.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: {
              type: "string",
              description: "Workspace-relative working directory."
            },
            timeout_seconds: { type: "number" }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      if (!isRecord(value)) {
        throw new TypeError("Tool arguments must be a JSON object.");
      }
      const timeoutSeconds = optionalNumber(value, "timeout_seconds");
      if (
        timeoutSeconds !== undefined &&
        (!Number.isInteger(timeoutSeconds) ||
          timeoutSeconds < 1 ||
          timeoutSeconds > 3_600)
      ) {
        throw new RangeError("timeout_seconds must be between 1 and 3600.");
      }
      return {
        command: requireString(value, "command"),
        cwd: optionalString(value, "cwd") ?? ".",
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds })
      };
    },
    async execute(args, context) {
      const cwd = await context.workspace.toAbsolutePath(args.cwd);
      const result = await context.commands.run({
        command: args.command,
        cwd,
        timeoutSeconds:
          args.timeoutSeconds ?? context.commandTimeoutSeconds,
        maxOutputCharacters: context.maxToolOutputCharacters,
        signal: context.signal,
        onOutput: (stream, text) => {
          const compact = text.replace(/\s+/g, " ").trim().slice(0, 300);
          if (compact.length > 0) {
            context.onProgress(`${stream}: ${compact}`);
          }
        }
      });
      return {
        command: args.command,
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        summary:
          result.exitCode === 0
            ? `Command completed successfully in ${result.durationMs} ms.`
            : `Command exited with code ${result.exitCode ?? "unknown"}.`
      };
    }
  };
}
