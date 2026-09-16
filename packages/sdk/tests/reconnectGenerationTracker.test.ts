import { describe, expect, it, vi } from "vitest";

import { ReconnectGenerationTracker } from "../src/platform/streaming/ReconnectGenerationTracker";

describe("ReconnectGenerationTracker", () => {
  it("finalizes once every attempted topic in a generation has settled", () => {
    const onSettled = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled);

    const generation = tracker.beginGeneration(["chat:a", "chat:b"]);
    expect(onSettled).not.toHaveBeenCalled();

    tracker.recordSettled("chat:a", true);
    expect(onSettled).not.toHaveBeenCalled();

    tracker.recordSettled("chat:b", false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      generation,
      attemptedTopics: new Set(["chat:a", "chat:b"]),
      joinedTopics: new Set(["chat:a"]),
    });
  });

  it("finalizes immediately when a generation begins with no topics to attempt", () => {
    const onSettled = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled);

    const generation = tracker.beginGeneration([]);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      generation,
      attemptedTopics: new Set(),
      joinedTopics: new Set(),
    });
  });

  it("finalizes a superseded generation with what settled before the drop, so nothing awaiting it hangs, without reporting its still-pending topic as failed", () => {
    const onSettled = vi.fn();
    const onGenerationDropped = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled, onGenerationDropped);

    const first = tracker.beginGeneration(["chat:a", "chat:b"]);
    tracker.recordSettled("chat:a", true); // one of two settles before the reconnect is superseded

    const second = tracker.beginGeneration(["chat:c"]);

    expect(onGenerationDropped).toHaveBeenCalledTimes(1);
    expect(onGenerationDropped).toHaveBeenCalledWith(first, 1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    // "chat:b" never got a reply before being superseded — that's not a
    // failure, so it's omitted from attemptedTopics entirely rather than
    // reported as attempted-but-not-joined.
    expect(onSettled).toHaveBeenNthCalledWith(1, {
      generation: first,
      attemptedTopics: new Set(["chat:a"]),
      joinedTopics: new Set(["chat:a"]),
    });

    // A stray settlement for the dropped generation's topic is now a no-op:
    // recordSettled always targets the current generation, and "chat:b"
    // was never attempted there.
    tracker.recordSettled("chat:b", true);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // The current generation still finalizes normally on its own topics.
    tracker.recordSettled("chat:c", true);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenNthCalledWith(2, {
      generation: second,
      attemptedTopics: new Set(["chat:c"]),
      joinedTopics: new Set(["chat:c"]),
    });
  });

  it("finalizes the current generation once its remaining topics settle", () => {
    const onSettled = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled);

    const generation = tracker.beginGeneration(["chat:c"]);
    tracker.recordSettled("chat:c", true);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      generation,
      attemptedTopics: new Set(["chat:c"]),
      joinedTopics: new Set(["chat:c"]),
    });
  });

  it("ignores a settlement for a topic that is not pending in the current generation", () => {
    const onSettled = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled);

    tracker.beginGeneration(["chat:a"]);
    tracker.recordSettled("chat:unknown", true);

    expect(onSettled).not.toHaveBeenCalled();
  });

  it("removeTopic finalizes a generation left pending only on the removed topic, without counting it as joined", () => {
    const onSettled = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled);

    const generation = tracker.beginGeneration(["chat:a", "chat:b"]);
    tracker.recordSettled("chat:a", true);
    tracker.removeTopic("chat:b");

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      generation,
      attemptedTopics: new Set(["chat:a", "chat:b"]),
      joinedTopics: new Set(["chat:a"]),
    });
  });

  it("removeTopic is a no-op for a topic that is not pending anywhere", () => {
    const onSettled = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled);

    tracker.beginGeneration(["chat:a"]);
    tracker.removeTopic("chat:unrelated");

    expect(onSettled).not.toHaveBeenCalled();
  });

  it("reset discards pending generations silently and restarts numbering from 1", () => {
    const onSettled = vi.fn();
    const onGenerationDropped = vi.fn();
    const tracker = new ReconnectGenerationTracker(onSettled, onGenerationDropped);

    tracker.beginGeneration(["chat:a"]);
    tracker.reset();

    expect(onSettled).not.toHaveBeenCalled();
    expect(onGenerationDropped).not.toHaveBeenCalled();

    const generation = tracker.beginGeneration(["chat:b"]);
    expect(generation).toBe(1);

    tracker.recordSettled("chat:b", true);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({
      generation: 1,
      attemptedTopics: new Set(["chat:b"]),
      joinedTopics: new Set(["chat:b"]),
    });
  });
});
