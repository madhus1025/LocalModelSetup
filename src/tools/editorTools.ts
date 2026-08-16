import {
  isRecord,
  optionalNumber,
  requireString
} from "../shared/json";
import type { AgentTool } from "./types";

export function createEditorTools(): AgentTool[] {
  return [
    activeFileTool(),
    selectedCodeTool(),
    openEditorsTool(),
    diagnosticsTool(),
    openFileTool(),
    formatDocumentTool()
  ];
}

function activeFileTool(): AgentTool<Record<string, never>> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "get_active_file",
        description: "Return the active editor file and current selection.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    parse: parseEmptyObject,
    async execute(_args, context) {
      const editor = context.workspace.getEditorSnapshot();
      return {
        activeFile: editor.activeFile ?? null,
        selection: editor.selection ?? null,
        summary:
          editor.activeFile === undefined
            ? "There is no active workspace editor."
            : `Active file is ${editor.activeFile}.`
      };
    }
  };
}

function selectedCodeTool(): AgentTool<Record<string, never>> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "get_selected_code",
        description: "Return selected code from the active editor.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    parse: parseEmptyObject,
    async execute(_args, context) {
      const editor = context.workspace.getEditorSnapshot();
      return {
        activeFile: editor.activeFile ?? null,
        selection: editor.selection ?? null,
        summary:
          editor.selection === undefined
            ? "There is no active code selection."
            : `Read selected code from ${editor.activeFile}.`
      };
    }
  };
}

function openEditorsTool(): AgentTool<Record<string, never>> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "get_open_editors",
        description: "List open and recently used workspace files.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    parse: parseEmptyObject,
    async execute(_args, context) {
      const editor = context.workspace.getEditorSnapshot();
      return {
        openFiles: editor.openFiles,
        recentFiles: editor.recentFiles,
        summary: `Found ${editor.openFiles.length} open workspace files.`
      };
    }
  };
}

function diagnosticsTool(): AgentTool<{ maxResults: number }> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "read_diagnostics",
        description:
          "Read current VS Code errors, warnings, information, and hints.",
        parameters: {
          type: "object",
          properties: {
            max_results: { type: "number" }
          },
          additionalProperties: false
        }
      }
    },
    parse(value) {
      if (!isRecord(value)) {
        throw new TypeError("Tool arguments must be an object.");
      }
      const maxResults = optionalNumber(value, "max_results") ?? 200;
      if (
        !Number.isInteger(maxResults) ||
        maxResults < 1 ||
        maxResults > 1_000
      ) {
        throw new RangeError("max_results must be between 1 and 1000.");
      }
      return { maxResults };
    },
    async execute(args, context) {
      const diagnostics = context.workspace.getDiagnostics(args.maxResults);
      return {
        count: diagnostics.length,
        diagnostics,
        summary: `Read ${diagnostics.length} diagnostics.`
      };
    }
  };
}

function openFileTool(): AgentTool<{ path: string; line?: number }> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "open_file",
        description:
          "Open a workspace file in VS Code and optionally reveal a one-based line.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            line: { type: "number" }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      if (!isRecord(value)) {
        throw new TypeError("Tool arguments must be an object.");
      }
      const line = optionalNumber(value, "line");
      return {
        path: requireString(value, "path"),
        ...(line === undefined ? {} : { line })
      };
    },
    async execute(args, context) {
      await context.workspace.reveal(args.path, args.line);
      return {
        path: args.path,
        line: args.line ?? null,
        summary: `Opened ${args.path}.`
      };
    }
  };
}

function formatDocumentTool(): AgentTool<{ path: string }> {
  return {
    kind: "write",
    definition: {
      type: "function",
      function: {
        name: "format_document",
        description:
          "Run the configured VS Code formatter and propose its resulting edits.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      if (!isRecord(value)) {
        throw new TypeError("Tool arguments must be an object.");
      }
      return { path: requireString(value, "path") };
    },
    async execute(args, context) {
      const formatted = await context.workspace.getFormattedText(args.path);
      return context.changes.propose(
        `Format ${args.path}`,
        [{ path: args.path, kind: "modify", proposedContent: formatted }],
        context.mode,
        context.autoApplySafeEdits,
        context.signal
      );
    }
  };
}

function parseEmptyObject(value: unknown): Record<string, never> {
  if (!isRecord(value) || Object.keys(value).length > 0) {
    throw new TypeError("This tool accepts an empty argument object.");
  }
  return {};
}
