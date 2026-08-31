import { describe, expect, it } from "vitest";

import {
  readBridgeIssueId,
  readBridgeSessionId,
  shouldResetAdapterThread,
} from "../src/contracts/bridgeMetadata";

describe("bridge message metadata", () => {
  it("reads the vertical-neutral keys", () => {
    const metadata = {
      bridge_session_id: "session-1",
      bridge_issue_id: "issue-1",
      reset_adapter_thread: true,
    };

    expect(readBridgeSessionId(metadata)).toBe("session-1");
    expect(readBridgeIssueId(metadata)).toBe("issue-1");
    expect(shouldResetAdapterThread(metadata)).toBe(true);
  });

  it("still reads the legacy vertical-specific keys on their own", () => {
    const metadata = {
      linear_session_id: "session-2",
      linear_issue_id: "issue-2",
      linear_reset_room_session: true,
    };

    expect(readBridgeSessionId(metadata)).toBe("session-2");
    expect(readBridgeIssueId(metadata)).toBe("issue-2");
    expect(shouldResetAdapterThread(metadata)).toBe(true);
  });

  it("prefers the neutral key when a bridge writes both", () => {
    expect(
      readBridgeSessionId({ bridge_session_id: "neutral", linear_session_id: "legacy" }),
    ).toBe("neutral");
  });

  it("reports nothing when the bridge set no identifiers", () => {
    expect(readBridgeSessionId(undefined)).toBeNull();
    expect(readBridgeIssueId({})).toBeNull();
    expect(shouldResetAdapterThread({})).toBe(false);
  });

  it("only resets on an explicit true", () => {
    expect(shouldResetAdapterThread({ reset_adapter_thread: "true" })).toBe(false);
    expect(shouldResetAdapterThread({ reset_adapter_thread: false })).toBe(false);
  });
});
