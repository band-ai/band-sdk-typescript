import { describe, expect, it } from "vitest";

import type { AgentControl } from "../src/platform/control";
import { ControlDeduplicator, MAX_SEEN_CONTROL_IDS, controlTargets } from "../src/runtime/control";

const control = (overrides: Partial<AgentControl> = {}): AgentControl => ({
  mode: "stop",
  scope: "room",
  agentId: "agent-1",
  roomId: "room-a",
  correlationId: "c-1",
  executionId: null,
  reason: null,
  ...overrides,
});

describe("ControlDeduplicator", () => {
  it("drops a repeat, and forgets the oldest id once it remembers more than it keeps", () => {
    const seen = new ControlDeduplicator();
    expect(seen.firstSighting(control({ correlationId: "first" }))).toBe(true);
    expect(seen.firstSighting(control({ correlationId: "first" }))).toBe(false);

    for (let index = 0; index < MAX_SEEN_CONTROL_IDS; index += 1) {
      seen.firstSighting(control({ correlationId: `filler-${index}` }));
    }

    expect(seen.firstSighting(control({ correlationId: "first" }))).toBe(true);
    expect(seen.firstSighting(control({ correlationId: `filler-${MAX_SEEN_CONTROL_IDS - 1}` }))).toBe(false);
  });
});

describe("controlTargets", () => {
  const handled = ["room-a", "room-b"];

  it("reaches the named room only while it is handled", () => {
    expect(controlTargets(control(), handled)).toEqual(["room-a"]);
    expect(controlTargets(control({ roomId: "room-c" }), handled)).toEqual([]);
  });

  it("reaches every handled room for an agent-wide signal, and none for a room signal naming no room", () => {
    expect(controlTargets(control({ scope: "agent", roomId: null }), handled)).toEqual(handled);
    expect(controlTargets(control({ roomId: null }), handled)).toEqual([]);
  });
});
