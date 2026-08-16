import { describe, expect, it } from "vitest";
import { SseDecoder } from "./sseDecoder";

describe("SseDecoder", () => {
  it("decodes events split across transport chunks", () => {
    const decoder = new SseDecoder();

    expect(decoder.push("data: {\"value\":")).toEqual([]);
    expect(decoder.push("1}\n\ndata: [DONE]\n\n")).toEqual([
      { data: "{\"value\":1}" },
      { data: "[DONE]" }
    ]);
  });

  it("joins multiline data and ignores comments", () => {
    const decoder = new SseDecoder();

    expect(
      decoder.push(": keepalive\nevent: message\ndata: first\ndata: second\n\n")
    ).toEqual([{ event: "message", data: "first\nsecond" }]);
  });
});
