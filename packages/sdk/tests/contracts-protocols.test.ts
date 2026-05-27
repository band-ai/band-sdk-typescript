import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createToolExecutorError,
  DEFAULT_AGENT_TOOLS_CAPABILITIES,
  isToolExecutorError,
  toLegacyToolExecutorErrorMessage,
} from "../src/contracts/protocols";
import type {
  AgentToolsCapabilities,
  PlatformMessageLike,
  PreprocessorContext,
} from "../src/contracts/protocols";

describe("contracts/protocols", () => {
  it("keeps shared protocol contracts strongly typed", () => {
    const capabilities: AgentToolsCapabilities = {
      peers: true,
      contacts: false,
      memory: false,
    };

    expectTypeOf(capabilities.peers).toEqualTypeOf<boolean>();
    expect(DEFAULT_AGENT_TOOLS_CAPABILITIES).toEqual({
      peers: true,
      contacts: true,
      memory: true,
    });
    expect(Object.values(DEFAULT_AGENT_TOOLS_CAPABILITIES)).toEqual([true, true, true]);
    expect(Object.keys(DEFAULT_AGENT_TOOLS_CAPABILITIES)).toEqual([
      "peers",
      "contacts",
      "memory",
    ]);
  });

  it("exposes preprocessor context over platform message contract", () => {
    expectTypeOf<PreprocessorContext["recordMessage"]>().parameter(0).toEqualTypeOf<PlatformMessageLike>();
    expect(typeof DEFAULT_AGENT_TOOLS_CAPABILITIES.peers).toBe("boolean");
    expect(typeof DEFAULT_AGENT_TOOLS_CAPABILITIES.contacts).toBe("boolean");
    expect(typeof DEFAULT_AGENT_TOOLS_CAPABILITIES.memory).toBe("boolean");
  });

  it("keeps contracts/protocols as the single import surface", () => {
    const srcDir = join(__dirname, "..", "src");
    const violations: string[] = [];

    function walkDir(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walkDir(fullPath);
          continue;
        }

        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) {
          continue;
        }

        const content = readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes("core/protocols")) {
            const relativePath = fullPath.replace(srcDir + "/", "");
            violations.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
    }

    walkDir(srcDir);
    expect(violations).toEqual([]);
  });

  it("provides helpers for the normalized tool executor error contract", () => {
    const error = createToolExecutorError({
      errorType: "ToolExecutionError",
      toolName: "thenvoi_send_message",
      message: "Mention not found",
      legacyMessage: "Error executing thenvoi_send_message: Mention not found",
      details: { mention: "@jane" },
    });

    expect(isToolExecutorError(error)).toBe(true);
    expect(toLegacyToolExecutorErrorMessage(error)).toBe(
      "Error executing thenvoi_send_message: Mention not found",
    );
    expect(toLegacyToolExecutorErrorMessage("already string")).toBe("already string");
    expect(toLegacyToolExecutorErrorMessage({ ok: true })).toBeNull();
  });
});
