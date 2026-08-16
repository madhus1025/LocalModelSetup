import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type {
  AgentController,
  AgentEventSink
} from "../agent/agentController";
import type { ConversationRepository } from "../agent/conversationRepository";
import type { AgentConfiguration } from "../extension/configuration";
import type { ModelClient } from "../llm/types";
import type {
  ApprovalManager,
  ApprovalRequestSink
} from "../security/approval";
import type {
  ChangeCoordinator,
  ChangeReviewSink
} from "../editor/changeCoordinator";
import { reviewRequestForChangeSet } from "../editor/changeCoordinator";
import type { ChangeSet } from "../editor/changeSet";
import type { ReviewDiffProvider } from "../editor/reviewDiffProvider";
import type {
  ChangeReviewRequest,
  ExtensionToWebviewMessage,
  ModelConnectionState,
  PermissionRequest,
  WebviewState,
  WebviewToExtensionMessage
} from "../shared/protocol";
import { isWebviewMessage } from "../shared/protocol";
import type { WorkspaceService } from "../workspace/types";

interface BoundServices {
  agent: AgentController;
  model: ModelClient;
  approvals: ApprovalManager;
  changes: ChangeCoordinator;
  diffs: ReviewDiffProvider;
  workspace: WorkspaceService;
}

export class ChatViewProvider
  implements
    vscode.WebviewViewProvider,
    AgentEventSink,
    ApprovalRequestSink,
    ChangeReviewSink
{
  public static readonly viewType = "localCodingAgent.chat";

  private view: vscode.WebviewView | undefined;
  private services: BoundServices | undefined;
  private pendingPermission: PermissionRequest | undefined;
  private pendingReview: ChangeReviewRequest | undefined;
  private modelState: ModelConnectionState = "unknown";
  private modelDetail: string | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly conversations: ConversationRepository,
    private readonly readConfiguration: () => AgentConfiguration,
    private readonly output: vscode.OutputChannel
  ) {}

  public bind(services: BoundServices): void {
    this.services = services;
    this.stateChanged();
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media")
      ]
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isWebviewMessage(message)) {
        this.notice("warning", "Ignored an invalid webview message.");
        return;
      }
      void this.handleMessage(message).catch((error: unknown) => {
        this.notice(
          "error",
          error instanceof Error ? error.message : String(error)
        );
      });
    });
  }

  public stateChanged(): void {
    void this.post({ type: "state", state: this.getState() });
  }

  public assistantDelta(messageId: string, delta: string): void {
    void this.post({ type: "assistantDelta", messageId, delta });
  }

  public assistantReasoningDelta(messageId: string, delta: string): void {
    void this.post({ type: "reasoningDelta", messageId, delta });
  }

  public notice(
    level: "info" | "warning" | "error",
    text: string
  ): void {
    this.output.appendLine(
      `[${new Date().toISOString()}] ${level.toUpperCase()}: ${text}`
    );
    void this.post({ type: "notice", level, text });
  }

  public showPermissionRequest(
    request: PermissionRequest | undefined
  ): void {
    this.pendingPermission = request;
    this.stateChanged();
  }

  public showChangeReview(changeSet: ChangeSet | undefined): void {
    this.pendingReview =
      changeSet === undefined
        ? undefined
        : reviewRequestForChangeSet(changeSet);
    this.stateChanged();
  }

  public async newConversation(): Promise<void> {
    if (this.services?.agent.isRunning === true) {
      this.notice("warning", "Stop the current task before starting a new one.");
      return;
    }
    await this.conversations.createConversation();
    this.stateChanged();
    await this.post({ type: "focusInput" });
  }

  public stop(): void {
    this.services?.agent.stop();
  }

  public async clearContext(): Promise<void> {
    if (this.services?.agent.isRunning === true) {
      this.notice("warning", "Stop the current task before clearing context.");
      return;
    }
    await this.conversations.clearActive();
    this.stateChanged();
  }

  public async checkModel(): Promise<void> {
    if (this.services === undefined) {
      this.modelState = "unavailable";
      this.modelDetail = "Open a workspace folder to initialize the agent.";
      this.stateChanged();
      return;
    }
    this.modelState = "checking";
    this.modelDetail = undefined;
    this.stateChanged();
    const result = await this.services.model.checkStatus();
    this.modelState = result.ready ? "ready" : "unavailable";
    this.modelDetail = result.detail;
    this.stateChanged();
  }

  private getState(): WebviewState {
    const configuration = this.readConfiguration();
    const conversation = this.conversations.active;
    return {
      mode: conversation.mode,
      conversations: this.conversations.summaries,
      activeConversationId: conversation.id,
      messages: conversation.displayMessages,
      activities: this.services?.agent.activities ?? [],
      model: {
        endpoint: configuration.endpoint,
        name: configuration.model,
        state: this.modelState,
        ...(this.modelDetail === undefined
          ? {}
          : { detail: this.modelDetail })
      },
      usage: conversation.usage,
      contextLimit: configuration.contextLength,
      isRunning: this.services?.agent.isRunning ?? false,
      ...(this.services?.agent.runStatus === undefined
        ? {}
        : { runStatus: this.services.agent.runStatus }),
      ...(this.pendingReview === undefined
        ? {}
        : { pendingReview: this.pendingReview }),
      ...(this.pendingPermission === undefined
        ? {}
        : { pendingPermission: this.pendingPermission })
    };
  }

  private async handleMessage(
    message: WebviewToExtensionMessage
  ): Promise<void> {
    switch (message.type) {
      case "ready":
        this.stateChanged();
        await this.checkModel();
        return;
      case "sendMessage":
        if (this.services === undefined) {
          this.notice("error", "Open a workspace folder before running a task.");
          return;
        }
        await this.services.agent.run(message.text, message.mode);
        return;
      case "setMode":
        if (this.services?.agent.isRunning === true) {
          this.notice("warning", "Mode cannot change while a task is running.");
          return;
        }
        await this.conversations.setMode(message.mode);
        this.stateChanged();
        return;
      case "stop":
        this.stop();
        return;
      case "retry":
        await this.retry();
        return;
      case "newConversation":
        await this.newConversation();
        return;
      case "selectConversation":
        if (this.services?.agent.isRunning === true) {
          this.notice(
            "warning",
            "Stop the current task before switching conversations."
          );
          return;
        }
        await this.conversations.selectConversation(message.id);
        this.stateChanged();
        return;
      case "clearContext":
        await this.clearContext();
        return;
      case "checkModel":
        await this.checkModel();
        return;
      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:local-ai.local-coding-agent"
        );
        return;
      case "openFile":
        await this.services?.workspace.reveal(message.path, message.line);
        return;
      case "openDiff":
        await this.services?.diffs.open(message.reviewId, message.path);
        return;
      case "reviewDecision":
        this.services?.changes.resolveReview(message.reviewId, {
          action: message.action,
          selectedHunkIds: message.selectedHunkIds
        });
        return;
      case "permissionDecision":
        if (message.allow && message.scope === "always") {
          void vscode.workspace
            .getConfiguration("localCodingAgent")
            .update("autoApproveCommands", true, vscode.ConfigurationTarget.Global)
            .then(
              () =>
                this.notice(
                  "info",
                  "Auto-approving commands from now on. Turn this off anytime in Settings → Local Coding Agent → Auto Approve Commands."
                ),
              () =>
                this.notice(
                  "warning",
                  "Could not persist auto-approval; this command was allowed once."
                )
            );
        }
        this.services?.approvals.resolve(
          message.permissionId,
          message.allow
        );
        return;
    }
  }

  private async retry(): Promise<void> {
    if (this.services === undefined) {
      this.notice("error", "Open a workspace folder before retrying.");
      return;
    }
    if (this.services.agent.isRunning) {
      this.notice("warning", "A task is already running.");
      return;
    }
    const text = await this.conversations.prepareRetry();
    if (text === undefined) {
      this.notice("info", "There is no user request to retry.");
      return;
    }
    this.stateChanged();
    await this.services.agent.run(
      text,
      this.conversations.active.mode,
      true
    );
  }

  private post(message: ExtensionToWebviewMessage): Thenable<boolean> {
    if (this.view === undefined) {
      return Promise.resolve(false);
    }
    return this.view.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString("base64");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css")
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Local Coding Agent</title>
</head>
<body>
  <div id="app" aria-live="polite"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
