import { describe, expect, it } from "vitest";

import {
  buildLinearBandBridgePrompt,
} from "../examples/linear-band/linear-band-bridge-agent";
import {
  resolveRestApiKeyForMode,
} from "../examples/linear-band/linear-band-bridge-server";

describe("Band Linear PM identity", () => {
  it("defaults to Band Linear PM identity", () => {
    const prompt = buildLinearBandBridgePrompt();
    expect(prompt).toContain("You are Band Linear PM.");
  });

  it("system prompt does not reference old name or bridge terminology", () => {
    const prompt = buildLinearBandBridgePrompt();
    expect(prompt).not.toContain("Thenvoi Linear Bridge");
    expect(prompt).not.toContain("Thenvoi Linear bridge agent");
    expect(prompt).not.toMatch(/\bbridge\b/i);
  });

  it("prefers BAND_API_KEY for the Linear Band bridge runtime", () => {
    const previousBand = process.env.BAND_API_KEY;
    const previousLegacy = process.env.THENVOI_API_KEY;
    process.env.BAND_API_KEY = "band-key";
    process.env.THENVOI_API_KEY = "legacy-key";

    try {
      expect(resolveRestApiKeyForMode({
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        embedBridgeAgent: false,
        embeddedBridgeConfig: null,
      })).toBe("band-key");
    } finally {
      if (previousBand === undefined) delete process.env.BAND_API_KEY;
      else process.env.BAND_API_KEY = previousBand;
      if (previousLegacy === undefined) delete process.env.THENVOI_API_KEY;
      else process.env.THENVOI_API_KEY = previousLegacy;
    }
  });
});
