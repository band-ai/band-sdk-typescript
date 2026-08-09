/**
 * P-C6-2 / P-C6-4: default service URLs move to app.band.ai, the derived REST
 * URL tracks the WS host, explicit URLs (including the legacy app.thenvoi.com
 * escape hatch) are byte-preserved, and the SDK default is byte-identical to
 * OpenClaw's default.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BandLink, deriveDefaultRestUrl } from "../src/platform/BandLink";

const BAND_WS = "wss://app.band.ai/api/v1/socket";
const BAND_REST = "https://app.band.ai";
const LEGACY_WS = "wss://app.thenvoi.com/api/v1/socket";

describe("P-C6-2/4: default and explicit service URLs", () => {
  it("the default WS URL is the Band host and REST is derived from it", () => {
    const link = new BandLink({ agentId: "a", apiKey: "k" });
    expect(link.wsUrl).toBe(BAND_WS);
    expect(link.restUrl).toBe(BAND_REST);
  });

  it("deriveDefaultRestUrl tracks the WS host and scheme", () => {
    expect(deriveDefaultRestUrl(BAND_WS)).toBe(BAND_REST);
    expect(deriveDefaultRestUrl(LEGACY_WS)).toBe("https://app.thenvoi.com");
    expect(deriveDefaultRestUrl("ws://localhost:8787/api/v1/socket")).toBe("http://localhost:8787");
  });

  it("an explicit legacy wsUrl pins app.thenvoi.com end to end (documented escape hatch)", () => {
    const link = new BandLink({ agentId: "a", apiKey: "k", wsUrl: LEGACY_WS });
    expect(link.wsUrl).toBe(LEGACY_WS); // byte-preserved
    expect(link.restUrl).toBe("https://app.thenvoi.com"); // derived from the pinned host
  });

  it("an explicit restUrl is byte-preserved independent of the WS host", () => {
    const link = new BandLink({ agentId: "a", apiKey: "k", restUrl: "https://custom.example.com" });
    expect(link.restUrl).toBe("https://custom.example.com");
  });

  it("the SDK default WS/REST are byte-identical to OpenClaw's defaults", () => {
    const openclawConfig = readFileSync(
      resolve(__dirname, "../../openclaw/src/config.ts"),
      "utf-8",
    );
    expect(openclawConfig).toContain(`export const DEFAULT_WS_URL = "${BAND_WS}";`);
    expect(openclawConfig).toContain(`export const DEFAULT_REST_URL = "${BAND_REST}";`);
  });
});
