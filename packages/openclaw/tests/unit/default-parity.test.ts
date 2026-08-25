/**
 * P-C6-2/4: OpenClaw's default service URLs are byte-identical to the SDK's
 * live defaults, and every duplicated WS/REST default/placeholder/env location
 * in `openclaw.plugin.json` matches them.
 *
 * This asserts behaviorally (constructs a real BandLink; imports OpenClaw's
 * exported constants; parses the manifest) rather than matching source text,
 * so a comment or dead declaration cannot make it pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BandLink } from "@band-ai/sdk";

import { DEFAULT_WS_URL, DEFAULT_REST_URL } from "../../src/config.js";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../../openclaw.plugin.json"), "utf8"),
) as unknown;

function collectStrings(node: unknown, out: string[]): void {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const v of node) collectStrings(v, out);
  else if (node && typeof node === "object")
    for (const v of Object.values(node)) collectStrings(v, out);
}

describe("SDK/OpenClaw default URL parity (P-C6-2/4)", () => {
  it("OpenClaw's default constants equal the SDK's live BandLink defaults", () => {
    const link = new BandLink({ agentId: "a", apiKey: "k" });
    expect(DEFAULT_WS_URL).toBe(link.wsUrl);
    expect(DEFAULT_REST_URL).toBe(link.restUrl);
  });

  it("every WS/REST URL in openclaw.plugin.json matches the Band defaults", () => {
    const all: string[] = [];
    collectStrings(manifest, all);
    // WS-scheme service URLs (defaults + placeholders + env defaults).
    const wsUrls = all.filter((s) => /^wss?:\/\//.test(s));
    // App REST URLs; excludes repository (github.com) and $schema (openclaw.ai).
    const restUrls = all.filter((s) => /^https?:\/\/app\./.test(s));

    // Not vacuous: the manifest duplicates each in default + placeholder + env.
    expect(wsUrls.length).toBeGreaterThanOrEqual(3);
    expect(restUrls.length).toBeGreaterThanOrEqual(3);

    for (const ws of wsUrls) expect(ws).toBe(DEFAULT_WS_URL);
    for (const rest of restUrls) expect(rest).toBe(DEFAULT_REST_URL);
  });

  it("is sensitive to a mismatch (inverse red-check)", () => {
    // The two defaults are distinct, so a WS/REST swap or a wrong host would
    // flip the assertions above.
    expect(DEFAULT_WS_URL).not.toBe(DEFAULT_REST_URL);
    expect("wss://app.wrong.example/api/v1/socket").not.toBe(DEFAULT_WS_URL);
    expect("https://app.wrong.example").not.toBe(DEFAULT_REST_URL);
  });
});
