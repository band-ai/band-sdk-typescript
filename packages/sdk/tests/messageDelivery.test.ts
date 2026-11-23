import { describe, expect, it } from "vitest";

import { BandError } from "@band-ai/rest-client";
import { RuntimeStateError } from "../src/core/errors";
import { NoopLogger } from "../src/core/logger";
import { deliverMessage, classifyFailedAttempt } from "../src/client/rest/messageDelivery";
import type { PlatformChatMessage } from "../src/client/rest/types";

/** A 503: the transport cannot say whether Band took the request. */
function serverError(): BandError {
  return new BandError({ statusCode: 503, body: { error: { code: "server_error", message: "Service unavailable", request_id: "req-1" } } });
}

const stored = {
  id: "msg-1",
  sender_id: "agent-1",
  message_type: "TEXT_MESSAGE",
  content: "held reply",
  mentions: [],
  inserted_at: "2026-01-01T00:00:00.000Z",
} as unknown as PlatformChatMessage;

describe("a post cut short while it settles before a resend", () => {
  it("keeps the failure the transport reported, never the cut", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let findCalls = 0;
    const delivery = deliverMessage({
      post: async () => {
        attempts += 1;
        throw serverError();
      },
      findPosted: async () => {
        findCalls += 1;
        return null;
      },
      stopped: controller.signal,
      logger: new NoopLogger(),
      roomId: "room-1",
      // Abort from the pause hook: the cut lands as soon as the resend pause arms.
      onResendPause: () => controller.abort(),
    });
    const error: unknown = await delivery.catch((thrown: unknown) => thrown);

    // The transport's own uncertainty stands: the failure that surfaces is the one it
    // reported, so the publication settles unknown. The cut may never stand in for it.
    expect(error).toBeInstanceOf(BandError);
    expect(error).not.toBeInstanceOf(RuntimeStateError);
    expect(classifyFailedAttempt(error)).toBe("uncertain");
    expect(attempts).toBe(1);
    // The read-back still ran: a commit in flight may have landed, and settles the post.
    expect(findCalls).toBe(1);
  });

  it("settles a commit that landed while the turn was cut", async () => {
    const controller = new AbortController();
    const delivery = deliverMessage({
      post: async () => {
        throw serverError();
      },
      findPosted: async () => stored,
      stopped: controller.signal,
      logger: new NoopLogger(),
      roomId: "room-1",
      onResendPause: () => controller.abort(),
    });
    const result = await delivery;

    // The room holds the post: it is found, not resent, and nothing failed.
    expect(result).toMatchObject({ found: { id: "msg-1" } });
  });

  it("still surfaces the transport's failure when the cut comes in a later pause", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let pauses = 0;
    const delivery = deliverMessage({
      post: async () => {
        attempts += 1;
        throw serverError();
      },
      stopped: controller.signal,
      logger: new NoopLogger(),
      roomId: "room-1",
      onResendPause: () => {
        pauses += 1;
        // First pause completes so a resend runs; cut on the pause before the next resend.
        if (pauses >= 2) controller.abort();
      },
    });
    const error: unknown = await delivery.catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BandError);
    expect(classifyFailedAttempt(error)).toBe("uncertain");
    // The cut ended the retries; the second resend never ran.
    expect(attempts).toBe(2);
  });
});
