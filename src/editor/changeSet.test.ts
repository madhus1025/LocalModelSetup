import { describe, expect, it } from "vitest";
import {
  applySelectedHunks,
  createChangeSet,
  hashContent
} from "./changeSet";

describe("ChangeSet", () => {
  it("applies only selected hunks against the verified base", () => {
    const base = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine"
    ].join("\n");
    const proposed = [
      "ONE",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "NINE"
    ].join("\n");
    const changeSet = createChangeSet("test", [
      {
        path: "sample.txt",
        kind: "modify",
        baseContent: base,
        proposedContent: proposed
      }
    ]);
    const file = changeSet.files[0]!;

    expect(file.review.hunks).toHaveLength(2);
    const result = applySelectedHunks(
      file,
      base,
      new Set([file.review.hunks[0]!.id])
    );

    expect(result).toContain("ONE");
    expect(result).toContain("nine");
    expect(result).not.toContain("NINE");
  });

  it("rejects stale proposals", () => {
    const changeSet = createChangeSet("test", [
      {
        path: "sample.txt",
        kind: "modify",
        baseContent: "before\n",
        proposedContent: "after\n"
      }
    ]);

    expect(() =>
      applySelectedHunks(
        changeSet.files[0]!,
        "changed independently\n",
        new Set(changeSet.files[0]!.review.hunks.map((hunk) => hunk.id))
      )
    ).toThrow("changed after");
    expect(changeSet.files[0]!.baseHash).toBe(hashContent("before\n"));
  });

  it("keeps empty create and delete operations as filesystem changes", () => {
    const changeSet = createChangeSet("empty changes", [
      {
        path: "empty-created.txt",
        kind: "create",
        baseContent: "",
        proposedContent: ""
      },
      {
        path: "empty-deleted.txt",
        kind: "delete",
        baseContent: "",
        proposedContent: ""
      }
    ]);

    expect(changeSet.files.map((file) => file.kind)).toEqual([
      "create",
      "delete"
    ]);
    expect(changeSet.files.every((file) => file.review.hunks.length === 1)).toBe(
      true
    );
    for (const file of changeSet.files) {
      expect(
        applySelectedHunks(
          file,
          "",
          new Set(file.review.hunks.map((hunk) => hunk.id))
        )
      ).toBe("");
    }
  });
});
