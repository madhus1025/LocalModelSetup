import type { AgentConfiguration } from "../extension/configuration";
import { isIP } from "node:net";
import { OpenAiCompatibleClient, type FetchLike } from "./openAiClient";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStatus,
  ModelStreamCallbacks
} from "./types";

export class ConfigurationBackedModelClient implements ModelClient {
  public constructor(
    private readonly readConfiguration: () => AgentConfiguration,
    private readonly fetchImplementation: FetchLike = fetch
  ) {}

  public checkStatus(signal?: AbortSignal): Promise<ModelStatus> {
    try {
      return this.createClient().checkStatus(signal);
    } catch (error) {
      return Promise.resolve({
        ready: false,
        detail: error instanceof Error ? error.message : String(error),
        availableModels: []
      });
    }
  }

  public streamChat(
    request: ModelRequest,
    callbacks: ModelStreamCallbacks
  ): Promise<ModelResponse> {
    return this.createClient().streamChat(request, callbacks);
  }

  private createClient(): OpenAiCompatibleClient {
    const config = this.readConfiguration();
    assertEndpointAllowed(config);
    return new OpenAiCompatibleClient(
      config.endpoint,
      config.model,
      this.fetchImplementation
    );
  }
}

function assertEndpointAllowed(configuration: AgentConfiguration): void {
  let url: URL;
  try {
    url = new URL(configuration.endpoint);
  } catch {
    throw new Error("The configured model endpoint is not a valid URL.");
  }
  if (configuration.allowRemoteEndpoint || isLoopback(url.hostname)) {
    return;
  }
  throw new Error(
    "Remote model endpoints are blocked. Enable localCodingAgent.allowRemoteEndpoint only if you explicitly intend to send repository context off this machine."
  );
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(normalized);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (ipVersion === 4 && normalized.split(".")[0] === "127")
  );
}
