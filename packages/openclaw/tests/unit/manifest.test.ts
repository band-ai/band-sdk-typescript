import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getMcpToolSchemas } from "../../src/mcp-tools.js";

interface PluginManifest {
  capabilities?: {
    mcp?: {
      tools?: string[];
    };
  };
  environment?: Record<string, { required?: boolean }>;
}

function readManifest(): PluginManifest {
  return JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf-8")) as PluginManifest;
}

describe("openclaw.plugin.json", () => {
  it("declares exactly the runtime MCP tools", () => {
    const manifestTools = readManifest().capabilities?.mcp?.tools ?? [];
    const runtimeTools = getMcpToolSchemas().map((tool) => tool.name);

    expect([...manifestTools].sort()).toEqual([...runtimeTools].sort());
  });

  it("does not require Band credentials for plugin discovery", () => {
    const environment = readManifest().environment ?? {};

    expect(environment.THENVOI_API_KEY?.required).toBe(false);
    expect(environment.THENVOI_AGENT_ID?.required).toBe(false);
  });
});
