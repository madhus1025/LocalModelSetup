import type {
  ChangeResult,
  ProposedFileMutation
} from "../editor/changeCoordinator";
import type { FunctionToolDefinition } from "../llm/types";
import type { AgentMode } from "../shared/protocol";
import type { CommandRequest } from "../terminal/commandRunner";
import type { ProcessResult } from "../terminal/processRunner";
import type { WorkspaceService } from "../workspace/types";

export type ToolKind = "read" | "write" | "command";

export interface ToolChangeService {
  propose(
    title: string,
    mutations: ProposedFileMutation[],
    mode: AgentMode,
    autoApplySafeEdits: boolean,
    signal: AbortSignal
  ): Promise<ChangeResult>;
}

export interface ToolGitService {
  status(signal: AbortSignal): Promise<string>;
  diff(
    signal: AbortSignal,
    staged?: boolean,
    path?: string
  ): Promise<string>;
  log(signal: AbortSignal, limit: number): Promise<string>;
  blame(
    signal: AbortSignal,
    path: string,
    startLine?: number,
    endLine?: number
  ): Promise<string>;
  inspectCommit(signal: AbortSignal, revision: string): Promise<string>;
}

export interface ToolCommandService {
  run(request: CommandRequest): Promise<ProcessResult>;
}

export interface ToolExecutionContext {
  mode: AgentMode;
  workspace: WorkspaceService;
  changes: ToolChangeService;
  git: ToolGitService;
  commands: ToolCommandService;
  autoApplySafeEdits: boolean;
  commandTimeoutSeconds: number;
  maxToolOutputCharacters: number;
  signal: AbortSignal;
  onProgress(detail: string): void;
}

export interface AgentTool<TArguments = unknown> {
  definition: FunctionToolDefinition;
  kind: ToolKind;
  parse(value: unknown): TArguments;
  execute(
    argumentsValue: TArguments,
    context: ToolExecutionContext
  ): Promise<unknown>;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
  summary: string;
}
