import { describe, expect, it } from "vitest";

import { ValidationError } from "../src/core/errors";
import { canonicalPlatformIdentity } from "../src/runtime/journal/identity";

describe("canonicalPlatformIdentity", () => {
  it("normalizes scheme and host case", () => {
    expect(canonicalPlatformIdentity("HTTPS://BAND.EXAMPLE")).toBe("https://band.example");
    expect(canonicalPlatformIdentity("http://Band.example")).toBe("http://band.example");
  });

  it("drops default ports and keeps meaningful base paths", () => {
    expect(canonicalPlatformIdentity("https://band.example:443")).toBe("https://band.example");
    expect(canonicalPlatformIdentity("http://band.example:80")).toBe("http://band.example");
    expect(canonicalPlatformIdentity("https://band.example:8443/api/")).toBe("https://band.example:8443/api");
    expect(canonicalPlatformIdentity("https://band.example/api/v2")).toBe("https://band.example/api/v2");
    // A bare root path is not a meaningful base path.
    expect(canonicalPlatformIdentity("https://band.example/")).toBe("https://band.example");
    expect(canonicalPlatformIdentity("https://band.example")).toBe("https://band.example");
  });

  it.each([
    "https://token@band.example",
    "https://token:secret@band.example",
    "https://band.example?api_key=secret",
    "https://band.example#fragment",
    "ftp://band.example",
    "not a url",
  ])("refuses %s, which would persist credentials or fold into another deployment", (value) => {
    expect(() => canonicalPlatformIdentity(value)).toThrow(ValidationError);
  });

  it("refuses a hostless endpoint", () => {
    expect(() => canonicalPlatformIdentity("https://")).toThrow(ValidationError);
  });
});
