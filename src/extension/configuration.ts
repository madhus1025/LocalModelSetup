import * as vscode from "vscode";

export interface AgentConfiguration {
  endpoint: string;
  model: string;
  allowRemoteEndpoint: boolean;
  contextLength: number;
  maxOutputTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  enableThinking: boolean;
  preserveThinking: boolean;
  maxIterations: number;
  maxModelRetries: number;
  autoApplySafeEdits: boolean;
  commandTimeoutSeconds: number;
  maxToolOutputCharacters: number;
}

export function readAgentConfiguration(): AgentConfiguration {
  const config = vscode.workspace.getConfiguration("localCodingAgent");
  return {
    endpoint: trimTrailingSlash(
      config.get("endpoint", "http://127.0.0.1:8080/v1")
    ),
    model: config.get("model", "kat-coder-v2.5-dev"),
    allowRemoteEndpoint: config.get("allowRemoteEndpoint", false),
    contextLength: config.get("contextLength", 65_536),
    maxOutputTokens: config.get("maxOutputTokens", 16_384),
    temperature: config.get("temperature", 1),
    topP: config.get("topP", 0.95),
    topK: config.get("topK", 20),
    enableThinking: config.get("enableThinking", true),
    preserveThinking: config.get("preserveThinking", true),
    maxIterations: config.get("maxIterations", 20),
    maxModelRetries: config.get("maxModelRetries", 2),
    autoApplySafeEdits: config.get("autoApplySafeEdits", false),
    commandTimeoutSeconds: config.get("commandTimeoutSeconds", 300),
    maxToolOutputCharacters: config.get(
      "maxToolOutputCharacters",
      30_000
    )
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
