/**
 * Unit test for the setup-only plugin entry (setup-entry.ts).
 *
 * The point of this module is to build the channel plugin with NO gateway so
 * the setup wizard never imports the WS transport or opens a connection.
 * Importing it here exercises that (transport-free) module-load path.
 */

import { describe, it, expect } from "vitest";
import bandSetupEntry from "../../src/setup-entry.js";
import { BAND_CHANNEL_ID } from "../../src/config.js";

describe("setup-entry default export", () => {
  it("wraps the Band channel plugin (built with no gateway) via defineSetupPluginEntry", () => {
    expect(bandSetupEntry.plugin.id).toBe(BAND_CHANNEL_ID);
    expect(bandSetupEntry.plugin.gateway).toEqual({});
  });
});
