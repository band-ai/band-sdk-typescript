import { beforeEach, describe, expect, it, vi } from "vitest";

import { AckTracker, type AckLink } from "../src/ack";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function fakeLink(): AckLink & { markProcessing: ReturnType<typeof vi.fn>; markProcessed: ReturnType<typeof vi.fn> } {
  return {
    markProcessing: vi.fn().mockResolvedValue(undefined),
    markProcessed: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AckTracker", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  it("marks processing on push and tracks the id as pending", async () => {
    const link = fakeLink();
    const tracker = new AckTracker(link, noopLogger);

    await tracker.markPushed("room-1", "msg-1");

    expect(link.markProcessing).toHaveBeenCalledWith("room-1", "msg-1");
    expect(link.markProcessed).not.toHaveBeenCalled();
    expect(tracker.pendingCount("room-1")).toBe(1);
  });

  it("marks every pending id in a room processed on reply, and clears the set", async () => {
    const link = fakeLink();
    const tracker = new AckTracker(link, noopLogger);

    await tracker.markPushed("room-1", "msg-1");
    await tracker.markPushed("room-1", "msg-2");
    await tracker.markPushed("room-2", "msg-3");

    await tracker.markRepliedIn("room-1");

    expect(link.markProcessed).toHaveBeenCalledTimes(2);
    expect(link.markProcessed).toHaveBeenCalledWith("room-1", "msg-1");
    expect(link.markProcessed).toHaveBeenCalledWith("room-1", "msg-2");
    expect(tracker.pendingCount("room-1")).toBe(0);
    // Unrelated room is untouched.
    expect(tracker.pendingCount("room-2")).toBe(1);
  });

  it("is a no-op when a room has no pending messages", async () => {
    const link = fakeLink();
    const tracker = new AckTracker(link, noopLogger);

    await tracker.markRepliedIn("room-1");

    expect(link.markProcessed).not.toHaveBeenCalled();
  });

  it("marks a gated-out message processed immediately, without tracking it as pending", async () => {
    const link = fakeLink();
    const tracker = new AckTracker(link, noopLogger);

    await tracker.markGatedOut("room-1", "msg-1");

    expect(link.markProcessed).toHaveBeenCalledWith("room-1", "msg-1");
    expect(tracker.pendingCount("room-1")).toBe(0);
  });

  it("logs and continues when markProcessing fails, still tracking the id as pending", async () => {
    const link = fakeLink();
    link.markProcessing.mockRejectedValueOnce(new Error("network error"));
    const tracker = new AckTracker(link, noopLogger);

    await tracker.markPushed("room-1", "msg-1");

    expect(noopLogger.error).toHaveBeenCalledWith(
      "markProcessing failed",
      expect.objectContaining({ room_id: "room-1", message_id: "msg-1" }),
    );
    expect(tracker.pendingCount("room-1")).toBe(1);
  });

  it("logs and continues when markProcessed fails for one of several pending ids", async () => {
    const link = fakeLink();
    link.markProcessed.mockRejectedValueOnce(new Error("network error"));
    const tracker = new AckTracker(link, noopLogger);

    await tracker.markPushed("room-1", "msg-1");
    await tracker.markPushed("room-1", "msg-2");

    await tracker.markRepliedIn("room-1");

    expect(link.markProcessed).toHaveBeenCalledTimes(2);
    expect(noopLogger.error).toHaveBeenCalledWith(
      "markProcessed (reply) failed",
      expect.objectContaining({ room_id: "room-1", message_id: "msg-1" }),
    );
    expect(tracker.pendingCount("room-1")).toBe(0);
  });
});
