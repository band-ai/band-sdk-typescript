import { describe, expect, it } from "vitest";

import { parseCapabilitiesFromEnv } from "../src/capabilities";

describe("parseCapabilitiesFromEnv", () => {
  it("defaults contacts to false and memory to true when unset", () => {
    expect(parseCapabilitiesFromEnv({})).toEqual({ contacts: false, memory: true });
  });

  it("parses BAND_ENABLE_CONTACTS=true", () => {
    expect(parseCapabilitiesFromEnv({ BAND_ENABLE_CONTACTS: "true" })).toEqual({
      contacts: true,
      memory: true,
    });
  });

  it("parses BAND_ENABLE_CONTACTS=false explicitly", () => {
    expect(parseCapabilitiesFromEnv({ BAND_ENABLE_CONTACTS: "false" })).toEqual({
      contacts: false,
      memory: true,
    });
  });

  it("parses BAND_ENABLE_MEMORY=false", () => {
    expect(parseCapabilitiesFromEnv({ BAND_ENABLE_MEMORY: "false" })).toEqual({
      contacts: false,
      memory: false,
    });
  });

  it("parses both enabled", () => {
    expect(
      parseCapabilitiesFromEnv({ BAND_ENABLE_CONTACTS: "true", BAND_ENABLE_MEMORY: "true" }),
    ).toEqual({ contacts: true, memory: true });
  });

  it("rejects a malformed value instead of silently defaulting", () => {
    expect(() => parseCapabilitiesFromEnv({ BAND_ENABLE_CONTACTS: "yes" })).toThrow();
  });
});
