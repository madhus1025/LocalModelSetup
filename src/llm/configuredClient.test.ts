import { describe, expect, it, vi } from "vitest";
import type { AgentConfiguration } from "../extension/configuration";
import { ConfigurationBackedModelClient } from "./configuredClient";

function configuration(
  endpoint: string,
  allowRemoteEndpoint = false
): AgentConfiguration {
  return {
    endpoint,
    model: "kat",
    allowRemoteEndpoint,
    contextLength: 65_536,
    maxOutputTokens: 1_000,
    temperature: 1,
    topP: 0.95,
    topK: 20,
    enableThinking: true,
    preserveThinking: true,
    maxIterations: 10,
    maxModelRetries: 1,
    autoApplySafeEdits: false,
    commandTimeoutSeconds: 30,
    maxToolOutputCharacters: 30_000
  };
}

describe("ConfigurationBackedModelClient", () => {
  it("rejects hostnames that only begin with a loopback-looking label", async () => {
    const fetchMock = vi.fn();
    const client = new ConfigurationBackedModelClient(
      () => configuration("http://127.0.0.1.attacker.example/v1"),
      fetchMock
    );

    const status = await client.checkStatus();

    expect(status.ready).toBe(false);
    expect(status.detail).toContain("Remote model endpoints are blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an exact IPv4 loopback endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ id: "kat" }] })
    );
    const client = new ConfigurationBackedModelClient(
      () => configuration("http://127.0.0.1:8080/v1"),
      fetchMock
    );

    await expect(client.checkStatus()).resolves.toMatchObject({ ready: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
