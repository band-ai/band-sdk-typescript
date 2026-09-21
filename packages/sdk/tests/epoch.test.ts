import { describe, expect, it } from "vitest";

import { Epoch } from "../src/core/epoch";

describe("Epoch", () => {
  it("increments generations and identifies stale captures", () => {
    const epoch = new Epoch();

    expect(epoch.current).toBe(0);
    expect(epoch.isStale(0)).toBe(false);

    expect(epoch.bump()).toBe(1);
    expect(epoch.current).toBe(1);
    expect(epoch.isStale(0)).toBe(true);
    expect(epoch.isStale(1)).toBe(false);

    expect(epoch.bump()).toBe(2);
    expect(epoch.current).toBe(2);
    expect(epoch.isStale(1)).toBe(true);
  });
});
