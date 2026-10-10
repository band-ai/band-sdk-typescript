import { describe, expect, it } from "vitest";

import { UnsupportedFeatureError } from "../src/core/errors";
import { supportsCapability, pruneUnsupported } from "../src/contracts/capabilities";
import { assertCapability } from "../src/runtime/capabilities";

describe("assertCapability", () => {
  it("does not throw when the capability is enabled", () => {
    expect(() =>
      assertCapability(
        { peers: true, contacts: false, memory: false, tasks: false },
        "peers",
      ),
    ).not.toThrow();
  });

  it("throws UnsupportedFeatureError when the capability is disabled", () => {
    expect(() =>
      assertCapability(
        { peers: false, contacts: false, memory: false, tasks: false },
        "peers",
      ),
    ).toThrow(UnsupportedFeatureError);
  });

  it("uses custom labels in error messages", () => {
    expect(() =>
      assertCapability(
        { peers: true, contacts: false, memory: false, tasks: false },
        "contacts",
        "Contact sync",
      ),
    ).toThrow("Contact sync is disabled by runtime capabilities");
  });
});

describe("tenant capability flags", () => {
  it.each<Readonly<Record<string, boolean>> | undefined>([undefined, {}, { ff_room_tasks: false }, { ff_room_tasks: true }])("gates only tasks with %j", (flags) => {
    const enabled = flags?.ff_room_tasks === true;
    expect(supportsCapability(flags, "tasks")).toBe(enabled);
    expect(supportsCapability(flags, "memory")).toBe(true);
    expect(pruneUnsupported({ peers: true, contacts: true, memory: true, tasks: true }, flags))
      .toEqual({ peers: true, contacts: true, memory: true, tasks: enabled });
    expect(pruneUnsupported({ peers: true, contacts: true, memory: true, tasks: false }, flags).tasks).toBe(false);
  });
});
