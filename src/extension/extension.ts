import * as vscode from "vscode";
import { VscodeAuditLogger } from "../audit/vscodeAuditLogger";
import { AgentController } from "../agent/agentController";
import { ConversationRepository } from "../agent/conversationRepository";
import { ModelConversationSummarizer } from "../agent/modelSummarizer";
import { ContextManager } from "../context/contextManager";
import { RepositoryContextBuilder } from "../context/repositoryContext";
import { ChangeCoordinator } from "../editor/changeCoordinator";
import { ReviewDiffProvider } from "../editor/reviewDiffProvider";
import { GitService } from "../git/gitService";
import { ConfigurationBackedModelClient } from "../llm/configuredClient";
import { ApprovalManager } from "../security/approval";
import { WorkspaceBoundary } from "../security/workspaceBoundary";
import { CommandRunner } from "../terminal/commandRunner";
import { createDefaultToolRegistry } from "../tools/createRegistry";
import type { ToolExecutionContext } from "../tools/types";
import { ChatViewProvider } from "../ui/chatViewProvider";
import { VscodeWorkspaceService } from "../workspace/vscodeWorkspaceService";
import {
  readAgentConfiguration,
  type AgentConfiguration
} from "./configuration";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Local Coding Agent", {
    log: true
  });
  output.appendLine("Activating Local Coding Agent.");
  const conversations = new ConversationRepository(context.globalState);
  const audit = new VscodeAuditLogger(context.globalStorageUri, output);
  const provider = new ChatViewProvider(
    context.extensionUri,
    conversations,
    readAgentConfiguration,
    output
  );

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand(
      "localCodingAgent.newConversation",
      () => provider.newConversation()
    ),
    vscode.commands.registerCommand("localCodingAgent.clearContext", () =>
      provider.clearContext()
    ),
    vscode.commands.registerCommand("localCodingAgent.stop", () =>
      provider.stop()
    ),
    vscode.commands.registerCommand("localCodingAgent.checkModel", () =>
      provider.checkModel()
    ),
    vscode.commands.registerCommand("localCodingAgent.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:local-ai.local-coding-agent"
      )
    ),
    vscode.commands.registerCommand("localCodingAgent.openAuditLog", () =>
      audit.open()
    )
  );

  const roots =
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  if (roots.length === 0) {
    provider.notice(
      "warning",
      "Open a workspace folder to enable repository tools."
    );
    return;
  }

  const boundary = new WorkspaceBoundary(roots);
  const workspace = new VscodeWorkspaceService(boundary);
  const model = new ConfigurationBackedModelClient(readAgentConfiguration);
  const approvals = new ApprovalManager(
    provider,
    audit,
    () => readAgentConfiguration().autoApproveCommands
  );
  const changes = new ChangeCoordinator(workspace, provider, audit);
  const diffs = new ReviewDiffProvider(changes);
  const commands = new CommandRunner(approvals);
  const initialConfiguration = readAgentConfiguration();
  const git = new GitService(
    boundary,
    initialConfiguration.maxToolOutputCharacters
  );
  const repositoryContext = new RepositoryContextBuilder(workspace, git);
  const summarizer = new ModelConversationSummarizer(model);
  const contextManager = new ContextManager(
    () => readAgentConfiguration().contextLength,
    () => readAgentConfiguration().maxOutputTokens,
    summarizer,
    (detail) => provider.notice("info", detail)
  );
  const tools = createDefaultToolRegistry();

  const controller = new AgentController(
    conversations,
    model,
    tools,
    repositoryContext,
    contextManager,
    (mode, signal, onProgress): ToolExecutionContext => {
      const configuration = readAgentConfiguration();
      return {
        mode,
        workspace,
        changes,
        git,
        commands,
        autoApplySafeEdits: configuration.autoApplySafeEdits,
        commandTimeoutSeconds: configuration.commandTimeoutSeconds,
        maxToolOutputCharacters: configuration.maxToolOutputCharacters,
        signal,
        onProgress
      };
    },
    (): ReturnType<typeof agentRunConfiguration> =>
      agentRunConfiguration(readAgentConfiguration()),
    provider,
    audit
  );

  provider.bind({
    agent: controller,
    model,
    approvals,
    changes,
    diffs,
    workspace
  });

  context.subscriptions.push(
    workspace,
    diffs,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("localCodingAgent")) {
        provider.stateChanged();
        if (
          event.affectsConfiguration("localCodingAgent.endpoint") ||
          event.affectsConfiguration("localCodingAgent.model")
        ) {
          void provider.checkModel();
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.notice(
        "warning",
        "Workspace folders changed. Reload the VS Code window to refresh agent boundaries."
      );
    })
  );

  output.appendLine(
    `Initialized for ${roots.length} workspace root${roots.length === 1 ? "" : "s"}.`
  );
}

export function deactivate(): void {}

function agentRunConfiguration(configuration: AgentConfiguration) {
  return {
    maxOutputTokens: configuration.maxOutputTokens,
    temperature: configuration.temperature,
    topP: configuration.topP,
    topK: configuration.topK,
    enableThinking: configuration.enableThinking,
    preserveThinking: configuration.preserveThinking,
    maxIterations: configuration.maxIterations,
    maxModelRetries: configuration.maxModelRetries
  };
}
