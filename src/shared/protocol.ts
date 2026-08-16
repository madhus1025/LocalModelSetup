export type AgentMode = "ask" | "edit" | "agent";

export type ModelConnectionState =
  | "unknown"
  | "checking"
  | "ready"
  | "unavailable";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  state: "complete" | "streaming" | "failed" | "cancelled";
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ToolActivity {
  id: string;
  name: string;
  summary: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  detail?: string;
}

export type RunPhase =
  | "preparing"
  | "thinking"
  | "responding"
  | "tool"
  | "finalizing";

export interface RunStatus {
  phase: RunPhase;
  startedAt: string;
  reasoningTokens: number;
  outputTokens: number;
  toolName?: string;
  thought?: string;
}

export interface ReviewHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ReviewFile {
  path: string;
  kind: "create" | "modify" | "delete";
  additions: number;
  deletions: number;
  hunks: ReviewHunk[];
}

export interface ChangeReviewRequest {
  id: string;
  title: string;
  files: ReviewFile[];
  createdAt: string;
}

export interface PermissionRequest {
  id: string;
  title: string;
  detail: string;
  reasons: string[];
  severity: "caution" | "danger";
  createdAt: string;
}

export interface WebviewState {
  mode: AgentMode;
  conversations: ConversationSummary[];
  activeConversationId?: string;
  messages: DisplayMessage[];
  activities: ToolActivity[];
  model: {
    endpoint: string;
    name: string;
    state: ModelConnectionState;
    detail?: string;
  };
  usage: TokenUsage;
  contextLimit: number;
  isRunning: boolean;
  runStatus?: RunStatus;
  pendingReview?: ChangeReviewRequest;
  pendingPermission?: PermissionRequest;
}

export type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "sendMessage"; text: string; mode: AgentMode }
  | { type: "setMode"; mode: AgentMode }
  | { type: "stop" }
  | { type: "retry" }
  | { type: "newConversation" }
  | { type: "selectConversation"; id: string }
  | { type: "clearContext" }
  | { type: "checkModel" }
  | { type: "openSettings" }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; reviewId: string; path: string }
  | {
      type: "reviewDecision";
      reviewId: string;
      action: "apply" | "reject";
      selectedHunkIds: string[];
    }
  | {
      type: "permissionDecision";
      permissionId: string;
      allow: boolean;
      scope?: "once" | "always";
    };

export type ExtensionToWebviewMessage =
  | { type: "state"; state: WebviewState }
  | { type: "assistantDelta"; messageId: string; delta: string }
  | { type: "reasoningDelta"; messageId: string; delta: string }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "focusInput" };

export function isWebviewMessage(
  value: unknown
): value is WebviewToExtensionMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  return typeof value.type === "string";
}
