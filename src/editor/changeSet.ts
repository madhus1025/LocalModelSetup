import { createHash, randomUUID } from "node:crypto";
import {
  applyPatch,
  parsePatch,
  structuredPatch,
  type StructuredPatch
} from "diff";
import type {
  ChangeReviewRequest,
  ReviewFile,
  ReviewHunk
} from "../shared/protocol";

export interface FileChange {
  path: string;
  kind: "create" | "modify" | "delete";
  baseContent: string;
  proposedContent: string;
  baseHash: string;
  patch: StructuredPatch;
  review: ReviewFile;
}

export interface ChangeSet {
  id: string;
  title: string;
  createdAt: string;
  files: FileChange[];
}

export interface ParsedPatchTarget {
  path: string;
  kind: "create" | "modify" | "delete";
  proposedContent: string;
}

export function createChangeSet(
  title: string,
  inputs: Array<{
    path: string;
    kind: "create" | "modify" | "delete";
    baseContent: string;
    proposedContent: string;
  }>
): ChangeSet {
  const files = inputs
    .filter(
      (input) =>
        input.kind !== "modify" ||
        input.baseContent !== input.proposedContent
    )
    .map((input) => createFileChange(input));
  return {
    id: randomUUID(),
    title,
    createdAt: new Date().toISOString(),
    files
  };
}

export function toReviewRequest(changeSet: ChangeSet): ChangeReviewRequest {
  return {
    id: changeSet.id,
    title: changeSet.title,
    createdAt: changeSet.createdAt,
    files: changeSet.files.map((file) => file.review)
  };
}

export function applySelectedHunks(
  file: FileChange,
  currentContent: string,
  selectedHunkIds: ReadonlySet<string>
): string | undefined {
  if (hashContent(currentContent) !== file.baseHash) {
    throw new Error(
      `${file.path} changed after the proposal was created. Regenerate the edit before applying it.`
    );
  }
  const hasSelectedReviewHunk = file.review.hunks.some((hunk) =>
    selectedHunkIds.has(hunk.id)
  );
  if (!hasSelectedReviewHunk) {
    return undefined;
  }
  if (file.kind === "create") {
    return file.proposedContent;
  }
  if (file.kind === "delete") {
    return "";
  }
  const selectedHunks = file.patch.hunks.filter((_hunk, index) =>
    selectedHunkIds.has(hunkId(file.path, index))
  );
  if (selectedHunks.length === 0) {
    return undefined;
  }
  const partialPatch: StructuredPatch = {
    ...file.patch,
    hunks: selectedHunks
  };
  const result = applyPatch(currentContent, partialPatch, { fuzzFactor: 0 });
  if (result === false) {
    throw new Error(
      `Selected hunks could not be applied cleanly to ${file.path}.`
    );
  }
  return result;
}

export function parseUnifiedPatchTargets(
  patchText: string,
  baseContentForPath: (path: string) => string
): ParsedPatchTarget[] {
  const patches = parsePatch(patchText);
  if (patches.length === 0) {
    throw new Error("The unified diff did not contain any file patches.");
  }
  return patches.map((patch) => {
    const oldPath = normalizePatchPath(patch.oldFileName);
    const newPath = normalizePatchPath(patch.newFileName);
    const kind =
      oldPath === undefined
        ? "create"
        : newPath === undefined
          ? "delete"
          : "modify";
    const targetPath = newPath ?? oldPath;
    if (targetPath === undefined) {
      throw new Error("Patch file path is missing.");
    }
    const baseContent = kind === "create" ? "" : baseContentForPath(targetPath);
    const proposedContent = applyPatch(baseContent, patch, { fuzzFactor: 0 });
    if (proposedContent === false) {
      throw new Error(`Patch did not apply cleanly to ${targetPath}.`);
    }
    return {
      path: targetPath,
      kind,
      proposedContent: kind === "delete" ? "" : proposedContent
    };
  });
}

export function getUnifiedPatchPaths(patchText: string): string[] {
  const patches = parsePatch(patchText);
  if (patches.length === 0) {
    throw new Error("The unified diff did not contain any file patches.");
  }
  return patches.map((patch) => {
    const targetPath =
      normalizePatchPath(patch.newFileName) ??
      normalizePatchPath(patch.oldFileName);
    if (targetPath === undefined) {
      throw new Error("Patch file path is missing.");
    }
    return targetPath;
  });
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createFileChange(input: {
  path: string;
  kind: "create" | "modify" | "delete";
  baseContent: string;
  proposedContent: string;
}): FileChange {
  const oldName = input.kind === "create" ? "/dev/null" : `a/${input.path}`;
  const newName = input.kind === "delete" ? "/dev/null" : `b/${input.path}`;
  const patch = structuredPatch(
    oldName,
    newName,
    input.baseContent,
    input.proposedContent,
    "",
    "",
    { context: 3 }
  );
  const patchHunks =
    patch.hunks.length === 0
      ? [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 0,
            newLines: 0,
            lines: [] as string[]
          }
        ]
      : patch.hunks;
  const hunks: ReviewHunk[] = patchHunks.map((hunk, index) => ({
    id: hunkId(input.path, index),
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines
  }));
  const additions = hunks.reduce(
    (total, hunk) =>
      total +
      hunk.lines.filter(
        (line) => line.startsWith("+") && !line.startsWith("+++")
      ).length,
    0
  );
  const deletions = hunks.reduce(
    (total, hunk) =>
      total +
      hunk.lines.filter(
        (line) => line.startsWith("-") && !line.startsWith("---")
      ).length,
    0
  );
  return {
    path: input.path,
    kind: input.kind,
    baseContent: input.baseContent,
    proposedContent: input.proposedContent,
    baseHash: hashContent(input.baseContent),
    patch,
    review: {
      path: input.path,
      kind: input.kind,
      additions,
      deletions,
      hunks
    }
  };
}

function hunkId(path: string, index: number): string {
  return `${path}::${index}`;
}

function normalizePatchPath(value: string | undefined): string | undefined {
  if (value === undefined || value === "/dev/null") {
    return undefined;
  }
  const withoutQuotes =
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return withoutQuotes.replace(/^(?:a|b)\//, "");
}
