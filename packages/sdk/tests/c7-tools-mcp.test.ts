/**
 * C7 platform tool + MCP rename proofs (P-TOOL-01 .. P-TOOL-08).
 *
 * The canonical registry advertises exactly 17 `band_*` tools; MCP qualifies
 * them as `mcp__band__band_*`; one exported `MCP_SERVER_NAME = "band"` owns
 * server-name defaults. Names change only. Legacy `thenvoi_*` /
 * `mcp__thenvoi__*` are neither advertised nor accepted; a raw legacy name
 * follows the existing unknown-tool path.
 */
import { describe, it, expect, vi } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { PassThrough } from "node:stream";

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
import { createBandSdkMcpServer } from "../src/mcp/sdk";
import { BandMcpStdioServer } from "../src/mcp/stdio";
import { CHAT_EVENT_TYPES } from "../src/contracts/chatEvents";
import { MEMORY_SYSTEMS, MEMORY_TYPES, MEMORY_SEGMENTS } from "../src/contracts/memory";
import { BandMcpServer } from "../src/mcp/server";
import { BandMcpSseServer } from "../src/mcp/sse";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const OPS = [
  "send_message", "send_event", "add_participant", "remove_participant",
  "get_participants", "lookup_peers", "create_chatroom", "list_contacts",
  "add_contact", "remove_contact", "list_contact_requests", "respond_contact_request",
  "list_memories", "store_memory", "get_memory", "supersede_memory", "archive_memory",
];

const sortedKeys = (o: Record<string, unknown>): string[] => Object.keys(o).sort();
const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe("P-TOOL-01: canonical registry is exactly 17 band_* tools", () => {
  const keys = Object.keys(TOOL_MODELS);

  it("has exactly 17 unique band_* keys and no legacy name", () => {
    expect(keys).toHaveLength(17);
    expect(new Set(keys).size).toBe(17);
    for (const k of keys) expect(k, `${k} must be band_*`).toMatch(/^band_/);
    for (const k of keys) expect(k).not.toMatch(/thenvoi/i);
    expect(ALL_TOOL_NAMES.size).toBe(17);
    expect(sorted(ALL_TOOL_NAMES)).toEqual(keys.sort());
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
    expect(CHAT_TOOL_NAMES.size + CONTACT_TOOL_NAMES.size + MEMORY_TOOL_NAMES.size).toBe(17);
    for (const m of MEMORY_TOOL_NAMES) expect(CHAT_TOOL_NAMES.has(m)).toBe(false);
    for (const c of CONTACT_TOOL_NAMES) expect(CHAT_TOOL_NAMES.has(c)).toBe(false);
  });
});

describe("P-TOOL-02: MCP registrations are the exact enabled canonical set", () => {
  it("all-enabled registrations equal ALL_TOOL_NAMES, qualified equal mcpToolNames(expected)", () => {
    expect(MCP_TOOL_PREFIX).toBe("mcp__band__");
    const regs = buildSingleContextRegistrations(new FakeAgentTools(), {
      enableMemoryTools: true,
      enableContactTools: true,
    });
    const names = regs.map((r) => r.name);
    // Exact set (no missing, no extra) — not just formatting.
    expect(sorted(names)).toEqual(sorted(ALL_TOOL_NAMES));
    expect(mcpToolNames(new Set(names))).toEqual(mcpToolNames(ALL_TOOL_NAMES));
    for (const q of mcpToolNames(new Set(names))) expect(q).toMatch(/^mcp__band__band_/);
  });

  it("gating produces exact subsets (a missing registration reds)", () => {
    const noMemory = buildSingleContextRegistrations(new FakeAgentTools(), {
      enableMemoryTools: false,
      enableContactTools: true,
    }).map((r) => r.name);
    expect(sorted(noMemory)).toEqual(sorted(BASE_TOOL_NAMES));
    for (const m of MEMORY_TOOL_NAMES) expect(noMemory).not.toContain(m);

    const chatOnly = buildSingleContextRegistrations(new FakeAgentTools(), {
      enableMemoryTools: false,
      enableContactTools: false,
    }).map((r) => r.name);
    expect(sorted(chatOnly)).toEqual(sorted(CHAT_TOOL_NAMES));
    // Missing-registration red-check: the exact-equality above fails if any
    // enabled tool is dropped or an extra appears.
    expect(chatOnly.length).toBe(7);
  });
});

describe("P-TOOL-03: MCP server-name defaults resolve to MCP_SERVER_NAME", () => {
  it("MCP_SERVER_NAME is the single Band server name", () => {
    expect(MCP_SERVER_NAME).toBe("band");
  });

  it("the SDK bridge advertises the Band server name", () => {
    const bridge = createBandSdkMcpServer({
      enableMemoryTools: false,
      getToolsForRoom: () => new FakeAgentTools(),
    });
    // McpSdkServerConfigWithInstance carries the advertised name; assert it without a cast.
    expect(bridge.serverConfig).toHaveProperty("name", MCP_SERVER_NAME);
  });

  it("the stdio server defaults to MCP_SERVER_NAME and honors an explicit override", async () => {
    interface StdioInternals { mcpServer: { server: { _serverInfo: { name: string } } } }
    const readName = (s: BandMcpStdioServer): string => {
      // Test-only introspection of the private mcpServer to read the SDK-stored serverInfo.
      const internals = s as unknown as StdioInternals;
      return internals.mcpServer.server._serverInfo.name;
    };

    const def = new BandMcpStdioServer({
      tools: new FakeAgentTools(),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
    await def.start();
    expect(readName(def)).toBe(MCP_SERVER_NAME);
    await def.stop();

    const custom = new BandMcpStdioServer({
      tools: new FakeAgentTools(),
      name: "custom-server",
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
    await custom.start();
    expect(readName(custom)).toBe("custom-server");
    await custom.stop();
  });

  // Connect a real MCP client and read the server name from the initialize
  // handshake — the only behavioral observation of an HTTP/SSE server's name.
  async function initializeName(url: string, kind: "http" | "sse"): Promise<string> {
    const client = new Client({ name: "c7-probe", version: "1.0.0" });
    const transport = kind === "http"
      ? new StreamableHTTPClientTransport(new URL(url))
      : new SSEClientTransport(new URL(url));
    await client.connect(transport);
    try {
      return client.getServerVersion()?.name ?? "";
    } finally {
      await client.close();
    }
  }

  it("the HTTP server advertises MCP_SERVER_NAME by default and honors an override", async () => {
    const def = new BandMcpServer({ tools: new FakeAgentTools() });
    await def.start();
    try {
      expect(def.url).toBeTruthy();
      expect(await initializeName(def.url!, "http")).toBe(MCP_SERVER_NAME);
    } finally {
      await def.stop();
    }

    const custom = new BandMcpServer({ tools: new FakeAgentTools(), name: "custom-http" });
    await custom.start();
    try {
      expect(await initializeName(custom.url!, "http")).toBe("custom-http");
    } finally {
      await custom.stop();
    }
  });

  it("the SSE server advertises MCP_SERVER_NAME by default and honors an override", async () => {
    const def = new BandMcpSseServer({ tools: new FakeAgentTools() });
    await def.start();
    try {
      expect(def.sseUrl).toBeTruthy();
      expect(await initializeName(def.sseUrl!, "sse")).toBe(MCP_SERVER_NAME);
    } finally {
      await def.stop();
    }

    const custom = new BandMcpSseServer({ tools: new FakeAgentTools(), name: "custom-sse" });
    await custom.start();
    try {
      expect(await initializeName(custom.sseUrl!, "sse")).toBe("custom-sse");
    } finally {
      await custom.stop();
    }
  });
});

describe("P-TOOL-04: every canonical name reaches a handler; every legacy name is unknown", () => {
  // One authoritative valid-args fixture; its keys must equal TOOL_MODELS exactly.
  const VALID_ARGS: Record<string, Record<string, unknown>> = {
    band_send_message: { content: "hi", mentions: ["@jane"] },
    band_send_event: { content: "t", message_type: CHAT_EVENT_TYPES[0] },
    band_add_participant: { name: "Weather Agent" },
    band_remove_participant: { name: "Weather Agent" },
    band_get_participants: {},
    band_lookup_peers: {},
    band_create_chatroom: {},
    band_list_contacts: {},
    band_add_contact: { handle: "@jane" },
    band_remove_contact: { handle: "@jane" },
    band_list_contact_requests: {},
    band_respond_contact_request: { action: "approve", request_id: "r1" },
    band_list_memories: {},
    band_store_memory: {
      content: "c", system: MEMORY_SYSTEMS[0], type: MEMORY_TYPES[0],
      segment: MEMORY_SEGMENTS[0], thought: "why",
    },
    band_get_memory: { memory_id: "m1" },
    band_supersede_memory: { memory_id: "m1" },
    band_archive_memory: { memory_id: "m1" },
  };

  function makeTools(): AgentTools {
    // Permissive rest: any method returns a benign success shape.
    const api = new Proxy({}, {
      get: () => async () => ({ ok: true, data: [], received: [], sent: [], id: "x" }),
    }) as unknown as RestApi;
    return new AgentTools({
      roomId: "room-1",
      rest: new RestFacade({ api }),
      participants: [{ id: "u1", handle: "@jane", name: "Jane", type: "User" }],
      capabilities: { peers: true, contacts: true, memory: true },
    });
  }

  const isNotFound = (r: unknown): boolean =>
    isToolExecutorError(r) && r.errorType === "ToolNotFoundError";

  it("the fixture covers exactly the 17 TOOL_MODELS rows (row-deletion red-check)", () => {
    expect(sortedKeys(VALID_ARGS)).toEqual(Object.keys(TOOL_MODELS).sort());
  });

  type ToolMethod =
    | "sendMessage" | "sendEvent" | "addParticipant" | "removeParticipant"
    | "getParticipants" | "lookupPeers" | "createChatroom" | "listContacts"
    | "addContact" | "removeContact" | "listContactRequests" | "respondContactRequest"
    | "listMemories" | "storeMemory" | "getMemory" | "supersedeMemory" | "archiveMemory";
  // Authoritative canonical-name -> handler-method routing.
  const ROUTING: Record<string, ToolMethod> = {
    band_send_message: "sendMessage", band_send_event: "sendEvent",
    band_add_participant: "addParticipant", band_remove_participant: "removeParticipant",
    band_get_participants: "getParticipants", band_lookup_peers: "lookupPeers",
    band_create_chatroom: "createChatroom", band_list_contacts: "listContacts",
    band_add_contact: "addContact", band_remove_contact: "removeContact",
    band_list_contact_requests: "listContactRequests", band_respond_contact_request: "respondContactRequest",
    band_list_memories: "listMemories", band_store_memory: "storeMemory",
    band_get_memory: "getMemory", band_supersede_memory: "supersedeMemory",
    band_archive_memory: "archiveMemory",
  };

  it("routes every canonical name to its own handler; every legacy name is ToolNotFound", async () => {
    // Coverage is exact — a missing/extra routing row reds here.
    expect(sortedKeys(ROUTING)).toEqual(Object.keys(TOOL_MODELS).sort());

    for (const [band, method] of Object.entries(ROUTING)) {
      const tools = makeTools();
      const spy = vi.spyOn(tools, method);
      const res = await tools.executeToolCall(band, VALID_ARGS[band] ?? {});
      expect(isNotFound(res), `canonical ${band} must reach a handler`).toBe(false);
      // Correct routing: exactly the mapped method runs (a mis-wired handler reds).
      expect(spy, `${band} must route to ${method}()`).toHaveBeenCalledTimes(1);

      const legacy = band.replace(/^band_/, "thenvoi_");
      const res2 = await tools.executeToolCall(legacy, VALID_ARGS[band] ?? {});
      expect(isNotFound(res2), `legacy ${legacy} must be ToolNotFound`).toBe(true);
      if (isToolExecutorError(res2)) expect(res2.toolName).toBe(legacy);
    }
  });

  it("discriminates: an unregistered band_ name is also ToolNotFound", async () => {
    const res = await makeTools().executeToolCall("band_does_not_exist", {});
    expect(isNotFound(res)).toBe(true);
  });
});

describe("P-TOOL-07: MCP host allowlist old exposes none, migrated exposes intended", () => {
  it("advertised tools match mcp__band__* and none match mcp__thenvoi__*", () => {
    const advertised = mcpToolNames(new Set(
      buildSingleContextRegistrations(new FakeAgentTools(), {
        enableMemoryTools: true, enableContactTools: true,
      }).map((r) => r.name),
    ));
    const matches = (glob: string): string[] => {
      const prefix = glob.replace(/\*$/, "");
      return advertised.filter((t) => t.startsWith(prefix));
    };
    expect(matches("mcp__thenvoi__*")).toHaveLength(0);
    expect(matches("mcp__band__*")).toEqual(advertised);
  });
});

describe("P-TOOL-08: completeness — no legacy tool/prefix/server/identifier in live surfaces", () => {
  const REPO_ROOT = resolve(__dirname, "..", "..", "..");
  // Migration-proof and legacy-env files legitimately reference the old name.
  const ALLOW_FILE = new RegExp([
    "(^|/)CHANGELOG", "(^|/)\\.agents/", "(^|/)docs/migrations/", "(^|/)\\.release-hold$",
    "c5-package-symbols\\.test\\.ts", "c5-migration-fixture\\.mjs",
    "generate-c5-migration-(map|doc)\\.mjs", "dump-sdk-surface\\.mjs",
    "c6-no-stale-live-thenvoi\\.test\\.ts", "c6-urls\\.test\\.ts",
    "linear-c3-compatibility\\.test\\.ts", "config-loader\\.test\\.ts",
    "tests/unit/config\\.test\\.ts", "e2e-config\\.test\\.ts",
    "release-hardening\\.test\\.mjs", "c7-tools-mcp\\.test\\.ts",
  ].join("|"));

  // Retained physical/wire/event/env identifiers + legacy/inverse-assertion prose:
  // legacy config-key back-compat (`.replace("thenvoi","band")`) and the
  // rebrand-absence assertions that reference the old repo/brand as excluded text.
  const ALLOW_LINE = /linear_thenvoi_bridge|linear_thenvoi_session_rooms|linear_thenvoi_bootstrap_requests|thenvoi_room_id|thenvoiRoomId|\.linear-thenvoi-example|LINEAR_THENVOI_|THENVOI_|legacy|deprecat|fallback|migration|rebrand|not\.toContain|=== "thenvoi"|globalThis|\.replace\("thenvoi"|thenvoi-sdk-typescript/;

  const FORBIDDEN: Array<[string, RegExp]> = [
    ["mcp prefix", /mcp__thenvoi__/],
    ["tool name", new RegExp(`thenvoi_(?:${OPS.join("|")})`)],
    ["tool wildcard prose", /thenvoi_\*|thenvoi_ prefix/],
    ["server literal", /(?:name|mcpServerName)\s*:\s*["']thenvoi["']|["']thenvoi["']\s*:/],
    ["stale scoped package", /@thenvoi\//],
    ["stale repo", /github\.com\/thenvoi\//],
    ["stale platform host", /platform\.thenvoi\.com/],
    ["removed example path", /examples\/linear-thenvoi/],
    ["stale identifier", /thenvoiApiKey/],
    ["stale product title", /Thenvoi TypeScript SDK/],
    ["brand word", /\bthenvoi\b/i],
  ];

  function scoped(): string[] {
    return execSync("git ls-files", { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !ALLOW_FILE.test(f));
  }

  it("scans a non-trivial file set (sanity)", () => {
    expect(scoped().length).toBeGreaterThan(50);
  });

  it("live source/prompts/tests/examples/docs carry no legacy tool/prefix/server/identifier", () => {
    const hits: Array<{ file: string; line: number; kind: string; text: string }> = [];
    for (const file of scoped()) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((text, i) => {
        if (ALLOW_LINE.test(text)) return;
        for (const [kind, re] of FORBIDDEN) {
          if (re.test(text)) hits.push({ file, line: i + 1, kind, text: text.trim() });
        }
      });
    }
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});
