import { describe, expect, it } from "vitest";
import { SecretRedactor } from "../security/redaction";
import { ProcessRunner } from "./processRunner";

describe("ProcessRunner", () => {
  it("bounds captured output after truncation", async () => {
    const limit = 250;
    const result = await new ProcessRunner().run({
      executable: process.execPath,
      args: [
        "-e",
        "for (let i = 0; i < 1000; i += 1) process.stdout.write('0123456789\\n')"
      ],
      cwd: process.cwd(),
      environment: process.env,
      timeoutMs: 5_000,
      maxOutputCharacters: limit,
      signal: new AbortController().signal,
      redactor: new SecretRedactor([])
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(limit);
    expect(
      result.stdout.match(/\[output truncated/g)?.length ?? 0
    ).toBeLessThanOrEqual(1);
  });
});
