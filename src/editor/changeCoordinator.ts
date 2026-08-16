import type { AgentMode } from "../shared/protocol";
import {
  noOpAuditSink,
  type AuditSink
} from "../audit/types";
import type { WorkspaceFileChange, WorkspaceService } from "../workspace/types";
import {
  applySelectedHunks,
  createChangeSet,
  type ChangeSet,
  toReviewRequest
} from "./changeSet";

export interface ProposedFileMutation {
  path: string;
  kind: "create" | "modify" | "delete";
  proposedContent?: string;
}

export interface ReviewResolution {
  action: "apply" | "reject";
  selectedHunkIds: string[];
}

export interface ChangeReviewSink {
  showChangeReview(changeSet: ChangeSet | undefined): void;
}

export interface ChangeResult {
  changeSetId: string;
  state: "applied" | "rejected" | "unchanged";
  changedFiles: string[];
}

export class ChangeCoordinator {
  private pending:
    | {
        changeSet: ChangeSet;
        resolve: (resolution: ReviewResolution) => void;
      }
    | undefined;
  private readonly history: ChangeSet[] = [];

  public constructor(
    private readonly workspace: WorkspaceService,
    private readonly sink: ChangeReviewSink,
    private readonly audit: AuditSink = noOpAuditSink
  ) {}

  public async propose(
    title: string,
    mutations: ProposedFileMutation[],
    mode: AgentMode,
    autoApplySafeEdits: boolean,
    signal: AbortSignal
  ): Promise<ChangeResult> {
    if (mode === "ask") {
      throw new Error("Ask mode does not permit workspace modifications.");
    }
    const inputs = await Promise.all(
      mutations.map(async (mutation) => {
        const exists = await this.workspace.exists(mutation.path);
        if (mutation.kind === "create" && exists) {
          throw new Error(`Cannot create existing file ${mutation.path}.`);
        }
        if (mutation.kind !== "create" && !exists) {
          throw new Error(`Cannot ${mutation.kind} missing file ${mutation.path}.`);
        }
        const baseContent = exists
          ? (await this.workspace.readText(mutation.path)).content
          : "";
        const proposedContent =
          mutation.kind === "delete"
            ? ""
            : mutation.proposedContent ??
              (() => {
                throw new TypeError(
                  `Mutation for ${mutation.path} has no proposed content.`
                );
              })();
        return {
          path: mutation.path,
          kind: mutation.kind,
          baseContent,
          proposedContent
        };
      })
    );
    const changeSet = createChangeSet(title, inputs);
    if (changeSet.files.length === 0) {
      return {
        changeSetId: changeSet.id,
        state: "unchanged",
        changedFiles: []
      };
    }
    this.history.unshift(changeSet);
    this.history.splice(20);
    this.audit.record("change.proposed", {
      changeSetId: changeSet.id,
      title,
      files: changeSet.files.map((file) => file.path),
      additions: changeSet.files.reduce(
        (sum, file) => sum + file.review.additions,
        0
      ),
      deletions: changeSet.files.reduce(
        (sum, file) => sum + file.review.deletions,
        0
      )
    });

    if (mode === "agent" && autoApplySafeEdits) {
      const allHunks = new Set(
        changeSet.files.flatMap((file) =>
          file.review.hunks.map((hunk) => hunk.id)
        )
      );
      const changedFiles = await this.apply(changeSet, allHunks);
      this.recordApplied(changeSet, changedFiles, allHunks.size);
      return {
        changeSetId: changeSet.id,
        state: "applied",
        changedFiles
      };
    }

    const resolution = await this.requestReview(changeSet, signal);
    if (resolution.action === "reject") {
      this.audit.record("change.rejected", {
        changeSetId: changeSet.id,
        files: changeSet.files.map((file) => file.path)
      });
      return {
        changeSetId: changeSet.id,
        state: "rejected",
        changedFiles: []
      };
    }
    const changedFiles = await this.apply(
      changeSet,
      new Set(resolution.selectedHunkIds)
    );
    this.recordApplied(
      changeSet,
      changedFiles,
      resolution.selectedHunkIds.length
    );
    return {
      changeSetId: changeSet.id,
      state: "applied",
      changedFiles
    };
  }

  public resolveReview(
    reviewId: string,
    resolution: ReviewResolution
  ): boolean {
    if (this.pending?.changeSet.id !== reviewId) {
      return false;
    }
    const pending = this.pending;
    this.pending = undefined;
    this.sink.showChangeReview(undefined);
    pending.resolve(resolution);
    return true;
  }

  public getChangeSet(id: string): ChangeSet | undefined {
    if (this.pending?.changeSet.id === id) {
      return this.pending.changeSet;
    }
    return this.history.find((changeSet) => changeSet.id === id);
  }

  public cancelPendingReview(): void {
    if (this.pending === undefined) {
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    this.sink.showChangeReview(undefined);
    pending.resolve({ action: "reject", selectedHunkIds: [] });
  }

  private requestReview(
    changeSet: ChangeSet,
    signal: AbortSignal
  ): Promise<ReviewResolution> {
    if (this.pending !== undefined) {
      throw new Error("Another code review is already pending.");
    }
    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Code review was cancelled.", "AbortError")
      );
    }
    return new Promise<ReviewResolution>((resolve, reject) => {
      const abort = (): void => {
        if (this.pending?.changeSet.id === changeSet.id) {
          this.pending = undefined;
          this.sink.showChangeReview(undefined);
          reject(new DOMException("Code review was cancelled.", "AbortError"));
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending = {
        changeSet,
        resolve: (resolution) => {
          signal.removeEventListener("abort", abort);
          resolve(resolution);
        }
      };
      this.sink.showChangeReview(changeSet);
    });
  }

  private async apply(
    changeSet: ChangeSet,
    selectedHunkIds: ReadonlySet<string>
  ): Promise<string[]> {
    const workspaceChanges: WorkspaceFileChange[] = [];
    const changedFiles: string[] = [];

    for (const file of changeSet.files) {
      if (
        file.kind === "create" &&
        (await this.workspace.exists(file.path))
      ) {
        throw new Error(
          `${file.path} was created after the proposal was generated. Regenerate the edit before applying it.`
        );
      }
      const currentContent =
        file.kind === "create"
          ? ""
          : (await this.workspace.readText(file.path)).content;
      const selectedContent = applySelectedHunks(
        file,
        currentContent,
        selectedHunkIds
      );
      if (selectedContent === undefined) {
        continue;
      }
      workspaceChanges.push(
        file.kind === "delete"
          ? { path: file.path, delete: true }
          : {
              path: file.path,
              content: selectedContent,
              ...(file.kind === "create" ? { create: true } : {})
            }
      );
      changedFiles.push(file.path);
    }
    if (workspaceChanges.length > 0) {
      await this.workspace.applyChanges(workspaceChanges);
    }
    return changedFiles;
  }

  private recordApplied(
    changeSet: ChangeSet,
    changedFiles: string[],
    selectedHunkCount: number
  ): void {
    this.audit.record("change.applied", {
      changeSetId: changeSet.id,
      files: changedFiles,
      selectedHunkCount
    });
  }
}

export function reviewRequestForChangeSet(changeSet: ChangeSet) {
  return toReviewRequest(changeSet);
}
