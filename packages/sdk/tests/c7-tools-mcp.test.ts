/**
 * C7 platform tool + MCP rename proofs (P-TOOL-01 .. P-TOOL-08).
 *
 * The canonical registry advertises 17 `band_*` tools; MCP qualifies them as
 * `mcp__band__band_*`; one exported `MCP_SERVER_NAME = "band"` owns server
 * defaults. Names change only — schemas, groups, handlers, and policy do not.
 * Legacy `thenvoi_*` / `mcp__thenvoi__*` are not advertised or accepted; a raw
 * legacy name follows the existing unknown-tool path.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  TOOL_MODELS,
  ALL_TOOL_NAMES,
  CHAT_TOOL_NAMES,
  MEMORY_TOOL_NAMES,
  CONTACT_TOOL_NAMES,
  BASE_TOOL_NAMES,
  MCP_TOOL_PREFIX,
  MCP_SERVER_NAME,
  mcpToolNames,
} from "../src/runtime/tools/schemas";
import { buildSingleContextRegistrations } from "../src/mcp/registrations";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { RestFacade } from "../src/client/rest/RestFacade";
import type { RestApi } from "../src/client/rest/types";
import { isToolExecutorError } from "../src/contracts/protocols";
import { FakeAgentTools } from "../src/testing/FakeAgentTools";

const OPS = [
  "send_message", "send_event", "add_participant", "remove_participant",
  "get_participants", "lookup_peers", "create_chatroom", "list_contacts",
  "add_contact", "remove_contact", "list_contact_requests", "respond_contact_request",
  "list_memories", "store_memory", "get_memory", "supersede_memory", "archive_memory",
];

describe("P-TOOL-01: canonical registry is exactly 17 band_* tools", () => {
  const keys = Object.keys(TOOL_MODELS);

  it("has exactly 17 unique band_* keys and no legacy name", () => {
    expect(keys).toHaveLength(17);
    expect(new Set(keys).size).toBe(17);
    for (const k of keys) expect(k, `${k} must be band_*`).toMatch(/^band_/);
    // Inverse: no residual Thenvoi tool name survives.
    for (const k of keys) expect(k).not.toMatch(/thenvoi/i);
    expect(ALL_TOOL_NAMES.size).toBe(17);
  });

  it("keeps group memberships and counts (chat 7 / contact 5 / memory 5)", () => {
    expect(MEMORY_TOOL_NAMES.size).toBe(5);
    expect(CONTACT_TOOL_NAMES.size).toBe(5);
    expect(CHAT_TOOL_NAMES.size).toBe(7);
    for (const set of [MEMORY_TOOL_NAMES, CONTACT_TOOL_NAMES, CHAT_TOOL_NAMES, BASE_TOOL_NAMES]) {
      for (const name of set) {
        expect(name).toMatch(/^band_/);
        expect(ALL_TOOL_NAMES.has(name), `${name} is a valid tool key`).toBe(true);
      }
    }
    // Chat, contact, memory partition the 17 tools with no overlap.
    expect(CHAT_TOOL_NAMES.size + CONTACT_TOOL_NAMES.size + MEMORY_TOOL_NAMES.size).toBe(17);
    for (const m of MEMORY_TOOL_NAMES) expect(CHAT_TOOL_NAMES.has(m)).toBe(false);
    for (const c of CONTACT_TOOL_NAMES) expect(CHAT_TOOL_NAMES.has(c)).toBe(false);
  });
});

describe("P-TOOL-02: MCP registrations qualify as mcp__band__band_*", () => {
  it("advertises every tool under the Band prefix, none under the old prefix", () => {
    expect(MCP_TOOL_PREFIX).toBe("mcp__band__");
    const fake = new FakeAgentTools();
    const registrations = buildSingleContextRegistrations(fake, {
      enableMemoryTools: true,
      enableContactTools: true,
    });
    const names = registrations.map((r) => r.name);
    for (const n of names) expect(n, `${n} registration is band_*`).toMatch(/^band_/);
    const qualified = mcpToolNames(new Set(names));
    expect(qualified.length).toBeGreaterThan(0);
    for (const q of qualified) {
      expect(q).toMatch(/^mcp__band__band_/);
      expect(q.startsWith("mcp__thenvoi__")).toBe(false);
    }
  });
});

describe("P-TOOL-03: one Band server constant owns MCP server defaults", () => {
  it("MCP_SERVER_NAME is the single Band server name", () => {
    expect(MCP_SERVER_NAME).toBe("band");
  });
  // Adapter/server-name defaults are exercised behaviorally in
  // opencode-adapter (`uses the mcpServerName "band" by default`) and
  // acp-client-adapter (restored session advertises name "band").
});

describe("P-TOOL-04: raw names — new execute, old are unknown tools", () => {
  function makeTools(): AgentTools {
    const api = {
      getAgentMe: async () => ({ id: "a1", name: "Agent", description: "" }),
      createChatMessage: async () => ({ ok: true }),
      createChatEvent: async () => ({ ok: true }),
      listChatParticipants: async () => [{ id: "u1", name: "Jane", type: "User", handle: "@jane" }],
      listContacts: async () => ({ data: [] }),
      addContact: async () => ({ ok: true }),
      listMemories: async () => ({ data: [] }),
    } as unknown as RestApi;
    return new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      participants: [{ id: "u1", handle: "@jane", name: "Jane", type: "User" }],
    });
  }

  const cases: Array<{ band: string; legacy: string; args: Record<string, unknown> }> = [
    { band: "band_send_message", legacy: "thenvoi_send_message", args: { content: "hi", mentions: ["@jane"] } },
    { band: "band_list_memories", legacy: "thenvoi_list_memories", args: {} },
    { band: "band_add_contact", legacy: "thenvoi_add_contact", args: { handle: "@jane" } },
  ];

  for (const c of cases) {
    it(`${c.band} executes; ${c.legacy} is a ToolNotFoundError`, async () => {
      const tools = makeTools();
      const ok = await tools.executeToolCall(c.band, c.args);
      expect(isToolExecutorError(ok), `new name ${c.band} should execute`).toBe(false);

      const bad = await tools.executeToolCall(c.legacy, c.args);
      expect(isToolExecutorError(bad), `old name ${c.legacy} should be unknown`).toBe(true);
      if (isToolExecutorError(bad)) {
        expect(bad.errorType).toBe("ToolNotFoundError");
        expect(bad.toolName).toBe(c.legacy);
      }
    });
  }
});

describe("P-TOOL-07: MCP host allowlist old exposes none, migrated exposes intended", () => {
  it("advertised tools match mcp__band__* and none match mcp__thenvoi__*", () => {
    const fake = new FakeAgentTools();
    const registrations = buildSingleContextRegistrations(fake, {
      enableMemoryTools: true,
      enableContactTools: true,
    });
    const advertised = mcpToolNames(new Set(registrations.map((r) => r.name)));
    const matches = (glob: string) => {
      const prefix = glob.replace(/\*$/, "");
      return advertised.filter((t) => t.startsWith(prefix));
    };
    // Old host allowlist exposes nothing the SDK now advertises.
    expect(matches("mcp__thenvoi__*")).toHaveLength(0);
    // Migrated allowlist exposes every advertised tool.
    expect(matches("mcp__band__*")).toEqual(advertised);
    expect(matches("mcp__band__*").length).toBe(advertised.length);
  });
});

describe("P-TOOL-08: completeness — no legacy tool/prefix/server hit", () => {
  const REPO_ROOT = resolve(__dirname, "..", "..", "..");
  const EXCLUDE = /(^|\/)(CHANGELOG|\.agents\/|docs\/migrations\/|c7-tools-mcp\.test\.ts)/;
  const TOOL = new RegExp(`thenvoi_(${OPS.join("|")})`);
  const PREFIX = /mcp__thenvoi__/;
  // Server-name literal as a default/name field or an mcpServers object key.
  const SERVER = /(?:\bname|mcpServerName)\s*:\s*["']thenvoi["']|["']thenvoi["']\s*:/;

  function scoped(): string[] {
    return execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !EXCLUDE.test(f));
  }

  it("scans a non-trivial file set (sanity)", () => {
    expect(scoped().length).toBeGreaterThan(50);
  });

  it("no source/prompt/test/example/doc advertises a legacy tool name, prefix, or server literal", () => {
    const hits: Array<{ file: string; line: number; text: string; kind: string }> = [];
    for (const file of scoped()) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((text, i) => {
        if (TOOL.test(text)) hits.push({ file, line: i + 1, text: text.trim(), kind: "tool" });
        if (PREFIX.test(text)) hits.push({ file, line: i + 1, text: text.trim(), kind: "prefix" });
        if (SERVER.test(text)) hits.push({ file, line: i + 1, text: text.trim(), kind: "server" });
      });
    }
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});
