import { describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "./approval";

describe("ApprovalManager", () => {
  it("waits for an explicit matching decision", async () => {
    const requests: Array<{ id: string } | undefined> = [];
    const manager = new ApprovalManager({
      showPermissionRequest: (request) => requests.push(request)
    });
    const pending = manager.request(
      "Approve",
      "command",
      ["reason"],
      "danger",
      new AbortController().signal
    );
    const request = requests[0];

    expect(request).toBeDefined();
    expect(manager.resolve("wrong-id", true)).toBe(false);
    expect(manager.resolve(request!.id, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(requests.at(-1)).toBeUndefined();
  });

  it("cancels a pending decision with the owning signal", async () => {
    const sink = { showPermissionRequest: vi.fn() };
    const manager = new ApprovalManager(sink);
    const controller = new AbortController();
    const pending = manager.request(
      "Approve",
      "command",
      ["reason"],
      "danger",
      controller.signal
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sink.showPermissionRequest).toHaveBeenLastCalledWith(undefined);
  });
});
