import {
  getUnifiedPatchPaths,
  parseUnifiedPatchTargets
} from "../editor/changeSet";
import type { ProposedFileMutation } from "../editor/changeCoordinator";
import {
  isRecord,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString
} from "../shared/json";
import { applyTextRangeEdits, type TextRangeEdit } from "../workspace/textEdits";
import type { AgentTool } from "./types";

export function createFileTools(): AgentTool[] {
  return [
    listFilesTool(),
    searchFilesTool(),
    readFileTool(),
    readFileRangeTool(),
    searchTextTool(),
    findSymbolTool(),
    createFileTool(),
    editFileTool(),
    deleteFileTool(),
    applyPatchTool()
  ];
}

function listFilesTool(): AgentTool<{
  path: string;
  maxResults: number;
}> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List files beneath a workspace-relative directory. Results respect ignore files and exclude generated dependency folders.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative directory, or . for the root."
            },
            max_results: {
              type: "number",
              description: "Maximum number of paths to return."
            }
          },
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      return {
        path: optionalString(record, "path") ?? ".",
        maxResults: boundedInteger(
          optionalNumber(record, "max_results") ?? 200,
          1,
          2_000
        )
      };
    },
    async execute(args, context) {
      const prefix =
        args.path === "." ? "" : `${args.path.replace(/\/+$/, "")}/`;
      const files = await context.workspace.listFiles(
        `${prefix}**/*`,
        args.maxResults
      );
      return {
        path: args.path,
        count: files.length,
        files,
        summary: `Listed ${files.length} files under ${args.path}.`
      };
    }
  };
}

function searchFilesTool(): AgentTool<{
  pattern: string;
  maxResults: number;
}> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "search_files",
        description:
          "Find workspace files by glob pattern, such as **/*.ts or src/**/auth*.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern." },
            max_results: {
              type: "number",
              description: "Maximum number of paths to return."
            }
          },
          required: ["pattern"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      return {
        pattern: requireString(record, "pattern"),
        maxResults: boundedInteger(
          optionalNumber(record, "max_results") ?? 200,
          1,
          2_000
        )
      };
    },
    async execute(args, context) {
      const files = await context.workspace.listFiles(
        args.pattern,
        args.maxResults
      );
      return {
        pattern: args.pattern,
        count: files.length,
        files,
        summary: `Found ${files.length} files for ${args.pattern}.`
      };
    }
  };
}

function readFileTool(): AgentTool<{ path: string }> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a UTF-8 text file from the workspace. Use read_file_range for large files.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      return { path: requireString(requireRecord(value), "path") };
    },
    async execute(args, context) {
      const snapshot = await context.workspace.readText(args.path);
      return {
        path: snapshot.path,
        version: snapshot.version,
        lineCount: snapshot.content.split("\n").length,
        content: snapshot.content,
        summary: `Read ${snapshot.path}.`
      };
    }
  };
}

function readFileRangeTool(): AgentTool<{
  path: string;
  startLine: number;
  endLine: number;
}> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "read_file_range",
        description:
          "Read an inclusive one-based line range from a workspace text file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            start_line: { type: "number" },
            end_line: { type: "number" }
          },
          required: ["path", "start_line", "end_line"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      const startLine = boundedInteger(
        requiredNumber(record, "start_line"),
        1,
        Number.MAX_SAFE_INTEGER
      );
      const endLine = boundedInteger(
        requiredNumber(record, "end_line"),
        startLine,
        Number.MAX_SAFE_INTEGER
      );
      return {
        path: requireString(record, "path"),
        startLine,
        endLine
      };
    },
    async execute(args, context) {
      const snapshot = await context.workspace.readText(args.path);
      const lines = snapshot.content.split("\n");
      if (args.startLine > lines.length) {
        throw new RangeError(
          `Start line ${args.startLine} exceeds the ${lines.length}-line file.`
        );
      }
      const actualEnd = Math.min(args.endLine, lines.length);
      return {
        path: snapshot.path,
        startLine: args.startLine,
        endLine: actualEnd,
        content: lines.slice(args.startLine - 1, actualEnd).join("\n"),
        summary: `Read ${snapshot.path}:${args.startLine}-${actualEnd}.`
      };
    }
  };
}

function searchTextTool(): AgentTool<{
  query: string;
  include?: string;
  exclude?: string;
  isRegex: boolean;
  isCaseSensitive: boolean;
  maxResults: number;
}> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "search_text",
        description:
          "Search workspace text with literal or regular-expression matching.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            include: { type: "string", description: "Optional include glob." },
            exclude: { type: "string", description: "Optional exclude glob." },
            is_regex: { type: "boolean" },
            case_sensitive: { type: "boolean" },
            max_results: { type: "number" }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      return {
        query: requireString(record, "query"),
        ...(optionalString(record, "include") === undefined
          ? {}
          : { include: optionalString(record, "include") }),
        ...(optionalString(record, "exclude") === undefined
          ? {}
          : { exclude: optionalString(record, "exclude") }),
        isRegex: optionalBoolean(record, "is_regex") ?? false,
        isCaseSensitive: optionalBoolean(record, "case_sensitive") ?? false,
        maxResults: boundedInteger(
          optionalNumber(record, "max_results") ?? 100,
          1,
          1_000
        )
      };
    },
    async execute(args, context) {
      const matches = await context.workspace.searchText(args);
      return {
        query: args.query,
        count: matches.length,
        matches,
        summary: `Found ${matches.length} text matches for ${args.query}.`
      };
    }
  };
}

function findSymbolTool(): AgentTool<{ query: string; maxResults: number }> {
  return {
    kind: "read",
    definition: {
      type: "function",
      function: {
        name: "find_symbol",
        description:
          "Find workspace symbols using VS Code language providers.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            max_results: { type: "number" }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      return {
        query: requireString(record, "query"),
        maxResults: boundedInteger(
          optionalNumber(record, "max_results") ?? 50,
          1,
          500
        )
      };
    },
    async execute(args, context) {
      const symbols = await context.workspace.findSymbols(
        args.query,
        args.maxResults
      );
      return {
        query: args.query,
        count: symbols.length,
        symbols,
        summary: `Found ${symbols.length} symbols for ${args.query}.`
      };
    }
  };
}

function createFileTool(): AgentTool<{ path: string; content: string }> {
  return {
    kind: "write",
    definition: {
      type: "function",
      function: {
        name: "create_file",
        description:
          "Propose creation of a UTF-8 workspace file. Edit mode always requests review.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          },
          required: ["path", "content"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      return {
        path: requireString(record, "path"),
        content: requireString(record, "content")
      };
    },
    async execute(args, context) {
      return context.changes.propose(
        `Create ${args.path}`,
        [{ path: args.path, kind: "create", proposedContent: args.content }],
        context.mode,
        context.autoApplySafeEdits,
        context.signal
      );
    }
  };
}

function editFileTool(): AgentTool<{
  path: string;
  edits: TextRangeEdit[];
}> {
  return {
    kind: "write",
    definition: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Propose precise one-based range replacements in one workspace file. Ranges must not overlap.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start_line: { type: "number" },
                  start_column: { type: "number" },
                  end_line: { type: "number" },
                  end_column: { type: "number" },
                  text: { type: "string" }
                },
                required: [
                  "start_line",
                  "start_column",
                  "end_line",
                  "end_column",
                  "text"
                ]
              }
            }
          },
          required: ["path", "edits"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      const record = requireRecord(value);
      if (!Array.isArray(record.edits) || record.edits.length === 0) {
        throw new TypeError('"edits" must be a non-empty array.');
      }
      return {
        path: requireString(record, "path"),
        edits: record.edits.map(parseTextEdit)
      };
    },
    async execute(args, context) {
      const snapshot = await context.workspace.readText(args.path);
      const proposedContent = applyTextRangeEdits(snapshot.content, args.edits);
      return context.changes.propose(
        `Edit ${snapshot.path}`,
        [
          {
            path: snapshot.path,
            kind: "modify",
            proposedContent
          }
        ],
        context.mode,
        context.autoApplySafeEdits,
        context.signal
      );
    }
  };
}

function deleteFileTool(): AgentTool<{ path: string }> {
  return {
    kind: "write",
    definition: {
      type: "function",
      function: {
        name: "delete_file",
        description:
          "Propose deletion of one workspace file. Deletion always appears in review unless Agent auto-apply is enabled.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      return { path: requireString(requireRecord(value), "path") };
    },
    async execute(args, context) {
      return context.changes.propose(
        `Delete ${args.path}`,
        [{ path: args.path, kind: "delete" }],
        context.mode,
        context.autoApplySafeEdits,
        context.signal
      );
    }
  };
}

function applyPatchTool(): AgentTool<{ patch: string }> {
  return {
    kind: "write",
    definition: {
      type: "function",
      function: {
        name: "apply_patch",
        description:
          "Propose a standard unified diff across one or more workspace files. Patches must apply exactly with no fuzz.",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "Complete unified diff." }
          },
          required: ["patch"],
          additionalProperties: false
        }
      }
    },
    parse(value) {
      return { patch: requireString(requireRecord(value), "patch") };
    },
    async execute(args, context) {
      const paths = getUnifiedPatchPaths(args.patch);
      const contentByPath = new Map<string, string>();
      for (const path of paths) {
        const exists = await context.workspace.exists(path);
        contentByPath.set(
          path,
          exists ? (await context.workspace.readText(path)).content : ""
        );
      }
      const targets = parseUnifiedPatchTargets(
        args.patch,
        (path) => contentByPath.get(path) ?? ""
      );
      const mutations: ProposedFileMutation[] = targets.map((target) => ({
        path: target.path,
        kind: target.kind,
        ...(target.kind === "delete"
          ? {}
          : { proposedContent: target.proposedContent })
      }));
      return context.changes.propose(
        `Apply patch to ${targets.length} file${targets.length === 1 ? "" : "s"}`,
        mutations,
        context.mode,
        context.autoApplySafeEdits,
        context.signal
      );
    }
  };
}

function parseTextEdit(value: unknown): TextRangeEdit {
  const record = requireRecord(value);
  return {
    startLine: boundedInteger(
      requiredNumber(record, "start_line"),
      1,
      Number.MAX_SAFE_INTEGER
    ),
    startColumn: boundedInteger(
      requiredNumber(record, "start_column"),
      1,
      Number.MAX_SAFE_INTEGER
    ),
    endLine: boundedInteger(
      requiredNumber(record, "end_line"),
      1,
      Number.MAX_SAFE_INTEGER
    ),
    endColumn: boundedInteger(
      requiredNumber(record, "end_column"),
      1,
      Number.MAX_SAFE_INTEGER
    ),
    text: requireString(record, "text")
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError("Tool arguments must be a JSON object.");
  }
  return value;
}

function requiredNumber(
  record: Record<string, unknown>,
  key: string
): number {
  const value = optionalNumber(record, key);
  if (value === undefined) {
    throw new TypeError(`Expected "${key}" to be a number.`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Expected an integer between ${minimum} and ${maximum}.`
    );
  }
  return value;
}
