import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captured, capturedMeta, fixturesRoot, listScenarios, type Frame } from "./support/claudeCaptures";

/**
 * These fixtures are committed as public evidence of a real CLI's protocol, so
 * what they must never carry is a rule of its own, not a hope that the capture
 * script remembered. Every check here scans the files as shipped.
 */
const PLACEHOLDER = "placeholder";
const FILES = ["stdout.ndjson", "stdin.ndjson", "mcp.ndjson", "meta.json"] as const;

function scenarioFile(scenario: string, file: string): string | null {
  try {
    return readFileSync(join(fixturesRoot, scenario, file), "utf8");
  } catch {
    return null; // an MCP log exists only where a probe was configured
  }
}

describe("the captured Claude CLI fixtures", () => {
  // A guard that scans nothing is a green light for a leak, so the set is pinned.
  const scenarios = listScenarios();
  expect(scenarios).toHaveLength(9);

  it("record a protocol shape a test can replay", () => {
    for (const scenario of scenarios) {
      const frames = captured(scenario);
      expect(frames.length, scenario).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(typeof frame.type, `${scenario} frame type`).toBe("string");
      }
    }
  });

  it("name no person, machine or session id", () => {
    const forbidden: Array<[string, RegExp]> = [
      ["a raw UUID", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
      ["a home path", /\/Users\/|\/home\/|\/private\/tmp\//],
      ["an email address", /[\w.+-]+@[\w-]+\.[\w.]{2,}/],
      ["the capture workspace", /claude-captures|cc-socks/],
      ["an account block", /"account"\s*:/],
      ["a process id", /"pid"\s*:/],
      ["a thinking signature", /"signature"\s*:/],
    ];
    for (const scenario of scenarios) {
      for (const file of FILES) {
        const text = scenarioFile(scenario, file);
        if (text === null) continue;
        for (const [what, pattern] of forbidden) {
          expect(text, `${scenario}/${file} contains ${what}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("neutralises the account's rate-limit and billing state", () => {
    let rateLimitFrames = 0;
    for (const scenario of scenarios) {
      const text = scenarioFile(scenario, "stdout.ndjson");
      if (text === null) continue;
      // The keys stay, so a parser still sees the frame's shape; no value may
      // report the account's real plan, credit or usage state.
      expect(text, `${scenario} leaks an out-of-credit state`).not.toMatch(/out_of_credits/);
      expect(text, `${scenario} leaks a real overage state`).not.toMatch(/"overage(?:Status|DisabledReason)":(?!\s*"placeholder")/);
      expect(text, `${scenario} leaks a real utilization`).not.toMatch(/"utilization":(?!\s*0)[^,}]/);
      expect(text, `${scenario} leaks a real reset time`).not.toMatch(/"resetsAt":(?!\s*0)[^,}]/);
      for (const frame of captured(scenario)) {
        const info = frame.rate_limit_info as Frame | undefined;
        if (!info) continue;
        rateLimitFrames += 1;
        expect(info.resetsAt, `${scenario} resetsAt`).toBe(0);
        expect(info.overageStatus, `${scenario} overageStatus`).toBe(PLACEHOLDER);
        expect(info.overageDisabledReason, `${scenario} overageDisabledReason`).toBe(PLACEHOLDER);
        expect(info.isUsingOverage, `${scenario} isUsingOverage`).toBe(false);
        for (const [window, state] of Object.entries(info.unifiedWindows as Record<string, Frame>)) {
          expect(state.utilization, `${scenario} ${window} utilization`).toBe(0);
          expect(state.resetsAt, `${scenario} ${window} resetsAt`).toBe(0);
          expect(typeof state.status, `${scenario} ${window} status`).toBe("string");
        }
      }
    }
    expect(rateLimitFrames, "the captures contain rate-limit frames to check").toBeGreaterThan(0);
  });

  it("record the CLI version and invocation they were captured with", () => {
    for (const scenario of scenarios) {
      const meta = capturedMeta(scenario);
      expect(meta.cliVersion, scenario).toBe("2.1.319");
      expect(meta.invocation[0], scenario).toBe("<claude-cli>");
      expect(meta.invocation, scenario).toContain("--strict-mcp-config");
      expect(meta.invocation, scenario).toContain("--permission-prompt-tool");
      const resumed = meta.invocation.indexOf("--resume");
      if (resumed !== -1) {
        // The resumed id is the scenario's own placeholder session, never a raw one.
        expect(meta.invocation[resumed + 1], scenario).toBe("SESSION-1");
      }
    }
  });
});
