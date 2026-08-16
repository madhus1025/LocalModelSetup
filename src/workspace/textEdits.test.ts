import { describe, expect, it } from "vitest";
import { applyTextRangeEdits } from "./textEdits";

describe("applyTextRangeEdits", () => {
  it("applies multiple non-overlapping one-based edits", () => {
    const source = "alpha\nbeta\ngamma";

    expect(
      applyTextRangeEdits(source, [
        {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 6,
          text: "ALPHA"
        },
        {
          startLine: 3,
          startColumn: 1,
          endLine: 3,
          endColumn: 6,
          text: "GAMMA"
        }
      ])
    ).toBe("ALPHA\nbeta\nGAMMA");
  });

  it("rejects overlapping edits", () => {
    expect(() =>
      applyTextRangeEdits("abcdef", [
        {
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 4,
          text: "x"
        },
        {
          startLine: 1,
          startColumn: 3,
          endLine: 1,
          endColumn: 5,
          text: "y"
        }
      ])
    ).toThrow("overlap");
  });
});
