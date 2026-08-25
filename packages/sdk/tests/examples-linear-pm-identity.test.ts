import { describe, expect, it } from "vitest";

import {
  buildLinearBandBridgePrompt,
} from "../examples/linear-band/linear-band-bridge-agent";

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
});
