import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceBoundary,
  WorkspaceBoundaryError
} from "./workspaceBoundary";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((temporaryPath) =>
      fs.rm(temporaryPath, { recursive: true, force: true })
    )
  );
});

describe("WorkspaceBoundary", () => {
  it("resolves workspace files and rejects traversal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-"));
    temporaryPaths.push(root);
    await fs.writeFile(path.join(root, "safe.txt"), "safe");
    const boundary = new WorkspaceBoundary([root]);

    await expect(boundary.resolveForRead("safe.txt")).resolves.toBe(
      await fs.realpath(path.join(root, "safe.txt"))
    );
    await expect(boundary.resolveForRead("../outside.txt")).rejects.toBeInstanceOf(
      WorkspaceBoundaryError
    );
  });

  it("rejects secret-bearing paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-"));
    temporaryPaths.push(root);
    await fs.writeFile(path.join(root, ".env"), "TOKEN=secret");
    const boundary = new WorkspaceBoundary([root]);

    await expect(boundary.resolveForRead(".env")).rejects.toThrow(
      "credential or secret-bearing"
    );
  });

  it("rejects existing and parent symlinks that escape on write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "local-agent-out-"));
    temporaryPaths.push(root, outside);
    const outsideFile = path.join(outside, "target.txt");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(outsideFile, path.join(root, "linked.txt"));
    await fs.symlink(outside, path.join(root, "linked-dir"));
    const boundary = new WorkspaceBoundary([root]);

    await expect(boundary.resolveForWrite("linked.txt")).rejects.toThrow(
      "outside"
    );
    await expect(
      boundary.resolveForWrite("linked-dir/new.txt")
    ).rejects.toThrow("outside");
  });
});
