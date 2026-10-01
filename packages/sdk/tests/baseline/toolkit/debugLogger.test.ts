import { afterEach, describe, expect, it, vi } from "vitest";

import { DEBUG_LOGS_ENV, debugLogger } from "./debugLogger";
import { FLAG_ON } from "./registry";

describe("debugLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is off, leaving the SDK's no-op logger, unless the flag is set", () => {
    expect(debugLogger("agent", {})).toBeUndefined();
    expect(debugLogger("agent", { [DEBUG_LOGS_ENV]: "0" })).toBeUndefined();
  });

  it("prints each line with a wall-clock stamp and its source when the flag is set", () => {
    const printed = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    debugLogger("agent one", { [DEBUG_LOGS_ENV]: FLAG_ON })?.warn("something happened", { roomId: "r1" });
    expect(printed).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[agent one\] something happened$/), { roomId: "r1" });
  });
});
