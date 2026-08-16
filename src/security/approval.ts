import { randomUUID } from "node:crypto";
import type { PermissionRequest } from "../shared/protocol";
import {
  noOpAuditSink,
  type AuditSink
} from "../audit/types";

export interface ApprovalRequestSink {
  showPermissionRequest(request: PermissionRequest | undefined): void;
}

export class ApprovalManager {
  private pending:
    | {
        request: PermissionRequest;
        resolve: (allowed: boolean) => void;
      }
    | undefined;

  public constructor(
    private readonly sink: ApprovalRequestSink,
    private readonly audit: AuditSink = noOpAuditSink,
    private readonly shouldAutoApprove: () => boolean = () => false
  ) {}

  public request(
    title: string,
    detail: string,
    reasons: string[],
    severity: "caution" | "danger",
    signal: AbortSignal
  ): Promise<boolean> {
    if (this.pending !== undefined) {
      throw new Error("Another permission request is already pending.");
    }
    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Permission request was cancelled.", "AbortError")
      );
    }
    if (this.shouldAutoApprove()) {
      this.audit.record("permission.auto_allowed", {
        title,
        severity,
        reasons
      });
      return Promise.resolve(true);
    }
    const request: PermissionRequest = {
      id: randomUUID(),
      title,
      detail,
      reasons,
      severity,
      createdAt: new Date().toISOString()
    };
    this.audit.record("permission.requested", {
      permissionId: request.id,
      title,
      severity,
      reasons
    });

    return new Promise<boolean>((resolve, reject) => {
      const abort = (): void => {
        if (this.pending?.request.id === request.id) {
          this.pending = undefined;
          this.sink.showPermissionRequest(undefined);
          reject(
            new DOMException("Permission request was cancelled.", "AbortError")
          );
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending = {
        request,
        resolve: (allowed) => {
          signal.removeEventListener("abort", abort);
          resolve(allowed);
        }
      };
      this.sink.showPermissionRequest(request);
    });
  }

  public resolve(id: string, allowed: boolean): boolean {
    if (this.pending?.request.id !== id) {
      return false;
    }
    const pending = this.pending;
    this.pending = undefined;
    this.sink.showPermissionRequest(undefined);
    this.audit.record("permission.resolved", {
      permissionId: id,
      allowed
    });
    pending.resolve(allowed);
    return true;
  }

  public cancel(): void {
    if (this.pending === undefined) {
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    this.sink.showPermissionRequest(undefined);
    this.audit.record("permission.cancelled", {
      permissionId: pending.request.id
    });
    pending.resolve(false);
  }
}
