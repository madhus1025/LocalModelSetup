import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

const sensitiveSegments = new Set([
  ".aws",
  ".azure",
  ".gnupg",
  ".ssh",
  ".env",
  "credentials",
  "secrets",
  "keychains"
]);

const sensitiveFileNames = new Set([
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa"
]);

export class WorkspaceBoundaryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

export class WorkspaceBoundary {
  private readonly normalizedRoots: string[];

  public constructor(roots: string[]) {
    if (roots.length === 0) {
      throw new WorkspaceBoundaryError(
        "Open a workspace folder before using repository tools."
      );
    }
    this.normalizedRoots = roots.map((root) => realpathSync(path.resolve(root)));
  }

  public get roots(): readonly string[] {
    return this.normalizedRoots;
  }

  public async resolveForRead(input: string): Promise<string> {
    const candidate = this.resolveLexically(input);
    this.assertNotSensitive(candidate);
    let realPath: string;
    try {
      realPath = await fs.realpath(candidate);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceBoundaryError(`Path does not exist: ${input}`);
      }
      throw error;
    }
    this.assertInsideWorkspace(realPath);
    return realPath;
  }

  public async resolveForWrite(input: string): Promise<string> {
    const candidate = this.resolveLexically(input);
    this.assertNotSensitive(candidate);
    try {
      const existingRealPath = await fs.realpath(candidate);
      this.assertInsideWorkspace(existingRealPath);
      this.assertNotSensitive(existingRealPath);
      return existingRealPath;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    const existingParent = await findExistingParent(path.dirname(candidate));
    const realParent = await fs.realpath(existingParent);
    this.assertInsideWorkspace(realParent);
    this.assertNotSensitive(realParent);
    const canonicalCandidate = path.resolve(
      realParent,
      path.relative(existingParent, candidate)
    );
    this.assertInsideWorkspace(canonicalCandidate);
    this.assertNotSensitive(canonicalCandidate);
    return canonicalCandidate;
  }

  public displayPath(absolutePath: string): string {
    const root = this.findContainingRoot(absolutePath);
    if (root === undefined) {
      throw new WorkspaceBoundaryError(
        "Cannot display a path outside the workspace."
      );
    }
    const relative = path.relative(root, absolutePath).split(path.sep).join("/");
    if (this.normalizedRoots.length === 1) {
      return relative.length === 0 ? "." : relative;
    }
    return `${path.basename(root)}/${relative}`;
  }

  public contains(absolutePath: string): boolean {
    return this.findContainingRoot(path.resolve(absolutePath)) !== undefined;
  }

  public rootFor(absolutePath: string): string {
    const root = this.findContainingRoot(path.resolve(absolutePath));
    if (root === undefined) {
      throw new WorkspaceBoundaryError(
        "The requested path is outside the open workspace."
      );
    }
    return root;
  }

  private resolveLexically(input: string): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new WorkspaceBoundaryError("Path must not be empty.");
    }

    const withoutFileScheme = trimmed.startsWith("file://")
      ? decodeURIComponent(new URL(trimmed).pathname)
      : trimmed;
    const direct = path.resolve(withoutFileScheme);
    if (path.isAbsolute(withoutFileScheme) && this.contains(direct)) {
      return direct;
    }

    if (this.normalizedRoots.length > 1) {
      const firstSegment = withoutFileScheme.split(/[\\/]/, 1)[0] ?? "";
      const selectedRoot = this.normalizedRoots.find(
        (root) => path.basename(root) === firstSegment
      );
      if (selectedRoot !== undefined) {
        const remainder = withoutFileScheme.slice(firstSegment.length + 1);
        const candidate = path.resolve(selectedRoot, remainder);
        this.assertInsideWorkspace(candidate);
        return candidate;
      }
    }

    const candidate = path.resolve(this.normalizedRoots[0]!, withoutFileScheme);
    this.assertInsideWorkspace(candidate);
    return candidate;
  }

  private assertInsideWorkspace(candidate: string): void {
    if (!this.contains(candidate)) {
      throw new WorkspaceBoundaryError(
        "The requested path resolves outside the open workspace."
      );
    }
  }

  private findContainingRoot(candidate: string): string | undefined {
    return this.normalizedRoots.find((root) => {
      const relative = path.relative(root, candidate);
      return (
        relative.length === 0 ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
      );
    });
  }

  private assertNotSensitive(candidate: string): void {
    const segments = candidate
      .split(path.sep)
      .map((segment) => segment.toLowerCase());
    const fileName = path.basename(candidate).toLowerCase();
    if (
      segments.some((segment) => sensitiveSegments.has(segment)) ||
      sensitiveFileNames.has(fileName) ||
      fileName.endsWith(".pem") ||
      fileName.endsWith(".p12") ||
      fileName.endsWith(".key")
    ) {
      throw new WorkspaceBoundaryError(
        "Access to credential or secret-bearing paths requires a dedicated user-authorized workflow."
      );
    }
  }
}

async function findExistingParent(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fs.access(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new WorkspaceBoundaryError(
        "Could not find an existing parent for the requested path."
      );
    }
    current = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
