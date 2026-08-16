import { describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleClient } from "./openAiClient";

function streamingResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

describe("OpenAiCompatibleClient", () => {
  it("streams text and assembles fragmented tool calls", async () => {
    const fetchMock = vi.fn(async () =>
      streamingResponse([
        'data: {"choices":[{"delta":{"content":"Checking "}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"src/a.ts\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n',
        "data: [DONE]\n\n"
      ])
    );
    const client = new OpenAiCompatibleClient(
      "http://localhost:8080/v1",
      "kat",
      fetchMock
    );
    const deltas: string[] = [];

    const result = await client.streamChat(
      {
        messages: [{ role: "user", content: "Inspect it." }],
        tools: [],
        maxTokens: 100,
        temperature: 1,
        topP: 0.95,
        topK: 20,
        enableThinking: true,
        preserveThinking: true,
        signal: new AbortController().signal
      },
      { onTextDelta: (delta) => deltas.push(delta) }
    );

    expect(deltas).toEqual(["Checking "]);
    expect(result.toolCalls).toEqual([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "read_file",
          arguments: '{"path":"src/a.ts"}'
        }
      }
    ]);
    expect(result.usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      estimated: false
    });
  });

  it("collapses leading system messages and demotes later ones", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        streamingResponse(["data: [DONE]\n\n"])
    );
    const client = new OpenAiCompatibleClient(
      "http://localhost:8080/v1",
      "kat",
      fetchMock
    );

    await client.streamChat(
      {
        messages: [
          { role: "system", content: "Base instructions." },
          { role: "system", content: "Repository context." },
          { role: "user", content: "Do it." },
          { role: "system", content: "Mid-stream reminder." }
        ],
        maxTokens: 100,
        temperature: 1,
        topP: 0.95,
        topK: 20,
        enableThinking: false,
        preserveThinking: false,
        signal: new AbortController().signal
      },
      { onTextDelta: () => undefined }
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1]?.body as string) ?? "{}"
    ) as { messages: { role: string; content: string }[] };
    expect(body.messages).toEqual([
      { role: "system", content: "Base instructions.\n\nRepository context." },
      { role: "user", content: "Do it." },
      { role: "user", content: "Mid-stream reminder." }
    ]);
    expect(
      body.messages.filter((message) => message.role === "system")
    ).toHaveLength(1);
  });

  it("propagates cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("cancelled", "AbortError"));
          });
        })
    );
    const client = new OpenAiCompatibleClient(
      "http://localhost:8080/v1",
      "kat",
      fetchMock
    );

    const pending = client.streamChat(
      {
        messages: [{ role: "user", content: "Wait." }],
        maxTokens: 100,
        temperature: 1,
        topP: 0.95,
        topK: 20,
        enableThinking: true,
        preserveThinking: true,
        signal: controller.signal
      },
      { onTextDelta: () => undefined }
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports advertised model availability", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ id: "kat" }, { id: "other" }] })
    );
    const client = new OpenAiCompatibleClient(
      "http://localhost:8080/v1",
      "kat",
      fetchMock
    );

    await expect(client.checkStatus()).resolves.toMatchObject({
      ready: true,
      availableModels: ["kat", "other"]
    });
  });
});
