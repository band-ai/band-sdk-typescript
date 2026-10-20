import { expect, it, vi } from "vitest";

import { opencodeMessageId } from "../src/adapters/opencode/messageId";

const IDS_PER_MILLISECOND = 50;

it("makes ids made in one millisecond sort in the order they were made", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  try {
    const ids = Array.from({ length: IDS_PER_MILLISECOND }, opencodeMessageId);
    expect(ids).toEqual([...ids].sort());
  } finally {
    vi.useRealTimers();
  }
});
