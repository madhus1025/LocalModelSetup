import {
  isRecord,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString
} from "../shared/json";
import type { ToolExecutionContext } from "./types";
import type { AgentTool } from "./types";

export function createGitTools(): AgentTool[] {
  return [
    simpleGitTool("git_status", "Inspect Git status.", async (context) =>
      context.git.status(context.signal)
    ),
    gitDiffTool(),
    gitLogTool(),
    gitBlameTool(),
    inspectCommitTool()
  ];
}

function gitDiffTool(): AgentTool<{
  staged: boolean;
  path?: string;
}> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "git_diff",
        description: "Inspect unstaged or staged Git changes.",
        parameters: {
          type: "object",
          properties: {
            staged: { type: "boolean" },
            path: { type: "string" }
          },
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      const selectedPath = optionalString(record, "path");
      return {
        staged: optionalBoolean(record, "staged") ?? false,
        ...(selectedPath === undefined ? {} : { path: selectedPath })
      };
    },
    async execute(args, context) {
      const output = await context.git.diff(
        context.signal,
        args.staged,
        args.path
      );
      return {
        staged: args.staged,
        path: args.path ?? null,
        output,
        summary: `Read ${args.staged ? "staged" : "unstaged"} Git diff.`
      };
    }
  };
}

function gitLogTool(): AgentTool<{ limit: number }> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "git_log",
        description: "Inspect recent Git commit history.",
        parameters: {
          type: "object",
          properties: { limit: { type: "number" } },
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      const limit = optionalNumber(record, "limit") ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new RangeError("limit must be between 1 and 100.");
      }
      return { limit };
    },
    async execute(args, context) {
      const output = await context.git.log(context.signal, args.limit);
      return {
        output,
        summary: `Read ${args.limit} recent Git commits.`
      };
    }
  };
}

function gitBlameTool(): AgentTool<{
  path: string;
  startLine?: number;
  endLine?: number;
}> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "git_blame",
        description: "Inspect Git blame for a file or line range.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            start_line: { type: "number" },
            end_line: { type: "number" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      const startLine = optionalNumber(record, "start_line");
      const endLine = optionalNumber(record, "end_line");
      return {
        path: requireString(record, "path"),
        ...(startLine === undefined ? {} : { startLine }),
        ...(endLine === undefined ? {} : { endLine })
      };
    },
    async execute(args, context) {
      const output = await context.git.blame(
        context.signal,
        args.path,
        args.startLine,
        args.endLine
      );
      return {
        output,
        summary: `Read Git blame for ${args.path}.`
      };
    }
  };
}

function inspectCommitTool(): AgentTool<{ revision: string }> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "inspect_commit",
        description: "Inspect one Git commit and its patch.",
        parameters: {
          type: "object",
          properties: { revision: { type: "string" } },
          required: ["revision"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      return {
        revision: requireString(requireRecord(value), "revision")
      };
    },
    async execute(args, context) {
      const output = await context.git.inspectCommit(
        context.signal,
        args.revision
      );
      return {
        output,
        summary: `Inspected commit ${args.revision}.`
      };
    }
  };
}

function simpleGitTool(
  name: string,
  description: string,
  operation: (context: ToolExecutionContext) => Promise<string>
): AgentTool<Record<string, never>> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      if (Object.keys(record).length > 0) {
        throw new TypeError(`${name} accepts no arguments.`);
      }
      return {};
    },
    async execute(_args, context) {
      const output = await operation(context);
      return { output, summary: `${name} completed.` };
    }
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("Tool arguments must be a JSON object.");
  }
  return value;
}
