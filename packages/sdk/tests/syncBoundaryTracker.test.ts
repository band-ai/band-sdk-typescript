import { describe, expect, it } from "vitest";

import { SyncBoundaryTracker } from "../src/runtime/SyncBoundaryTracker";

describe("SyncBoundaryTracker", () => {
  it("starts with one open boundary (the initial one) and is not complete", () => {
    const tracker = new SyncBoundaryTracker();
    expect(tracker.isComplete).toBe(false);
    expect(tracker.initial.messageId).toBeNull();
  });

  it("becomes complete once the initial boundary is completed", () => {
    const tracker = new SyncBoundaryTracker();
    tracker.completeBoundary(tracker.initial);
    expect(tracker.isComplete).toBe(true);
  });

  it("anchors the oldest not-yet-anchored boundary to a live message id", () => {
    const tracker = new SyncBoundaryTracker();
    tracker.anchor("message-1");
    expect(tracker.initial.messageId).toBe("message-1");
  });

  it("does not anchor a boundary that's already anchored, even if it's still open", () => {
    const tracker = new SyncBoundaryTracker();
    tracker.anchor("message-1");
    const second = tracker.beginBoundary();
    tracker.anchor("message-2");
    expect(tracker.initial.messageId).toBe("message-1");
    expect(second.messageId).toBe("message-2");
  });

  it("recognizes a message id as a sync point only for the boundary it anchored", () => {
    const tracker = new SyncBoundaryTracker();
    tracker.anchor("message-1");
    expect(tracker.isSyncPoint(tracker.initial, "message-1")).toBe(true);
    expect(tracker.isSyncPoint(tracker.initial, "message-2")).toBe(false);
  });

  it("never treats an unanchored boundary as a sync point for any message", () => {
    const tracker = new SyncBoundaryTracker();
    expect(tracker.isSyncPoint(tracker.initial, "message-1")).toBe(false);
  });

  it("tracks executed message ids permanently, surviving repeated checks", () => {
    const tracker = new SyncBoundaryTracker();
    expect(tracker.isExecuted("message-1")).toBe(false);
    tracker.recordExecuted("message-1");
    expect(tracker.isExecuted("message-1")).toBe(true);
    expect(tracker.isExecuted("message-1")).toBe(true);
  });

  it("queues new boundaries in order, only completing one from the front", () => {
    const tracker = new SyncBoundaryTracker();
    const second = tracker.beginBoundary();
    const third = tracker.beginBoundary();
    expect(tracker.isComplete).toBe(false);

    // Completing a boundary that isn't at the front of the queue is a no-op:
    // the initial boundary's own scan hasn't finished yet, so nothing is
    // dequeued and the tracker is still not complete.
    tracker.completeBoundary(third);
    expect(tracker.isComplete).toBe(false);

    tracker.completeBoundary(tracker.initial);
    tracker.completeBoundary(second);
    tracker.completeBoundary(third);
    expect(tracker.isComplete).toBe(true);
  });

  it("ignores completing a boundary twice or one that was never queued", () => {
    const tracker = new SyncBoundaryTracker();
    tracker.completeBoundary(tracker.initial);
    expect(tracker.isComplete).toBe(true);

    tracker.completeBoundary(tracker.initial);
    expect(tracker.isComplete).toBe(true);

    tracker.completeBoundary({ messageId: null });
    expect(tracker.isComplete).toBe(true);
  });
});
