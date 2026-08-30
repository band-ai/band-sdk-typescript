import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import pkg from "../package.json" with { type: "json" };

// These assertions run against the BUILT package, not src. A src-only surface test cannot
// see a type/value mismatch under verbatimModuleSyntax -- which is exactly the class of bug
// the HistoryProvider case below was.
const SDK_ROOT = resolve(__dirname, "..");
const requireCjs = createRequire(import.meta.url);

type Mod = Record<string, unknown>;

function distEntry(subpath: string, condition: "import" | "require"): string {
  const entry = (pkg.exports as Record<string, Record<string, string>>)[subpath];
  if (!entry?.[condition]) {
    throw new Error(`package.json#exports is missing ${subpath} -> ${condition}`);
  }
  return resolve(SDK_ROOT, entry[condition]);
}

let rootEsm: Mod;
let rootCjs: Mod;
let coreEsm: Mod;

beforeAll(async () => {
  rootEsm = (await import(pathToFileURL(distEntry(".", "import")).href)) as Mod;
  coreEsm = (await import(pathToFileURL(distEntry("./core", "import")).href)) as Mod;
  rootCjs = requireCjs(distEntry(".", "require")) as Mod;
});

describe("HistoryProvider is reachable as a value from the root entry", () => {
  // HistoryProvider is a class but was exported inside an `export type {}` block, so it had
  // no runtime binding: `new HistoryProvider([])` threw from the built package.
  it("constructs from the built ESM entry", () => {
    const Ctor = rootEsm.HistoryProvider as new (messages: unknown[]) => unknown;
    expect(typeof Ctor).toBe("function");
    expect(() => new Ctor([])).not.toThrow();
  });

  it("constructs from the built CJS entry", () => {
    const Ctor = rootCjs.HistoryProvider as new (messages: unknown[]) => unknown;
    expect(typeof Ctor).toBe("function");
    expect(() => new Ctor([])).not.toThrow();
  });
});

describe("the BandSdkError family is catchable from the root entry", () => {
  const names = [
    "BandSdkError",
    "UnsupportedFeatureError",
    "ValidationError",
    "TransportError",
    "RuntimeStateError",
  ] as const;

  it.each(names)("%s is a constructable class on the built ESM entry", (name) => {
    const Ctor = rootEsm[name] as new (message: string) => Error;
    expect(typeof Ctor).toBe("function");
    const instance = new Ctor("boom");
    expect(instance).toBeInstanceOf(Error);
    expect(instance.name).toBe(name);
  });

  it.each(names)("%s is also on the built CJS entry", (name) => {
    expect(typeof rootCjs[name]).toBe("function");
  });

  it("every one of them satisfies instanceof BandSdkError", () => {
    const Base = rootEsm.BandSdkError as new (message: string) => Error;
    for (const name of names) {
      const Ctor = rootEsm[name] as new (message: string) => Error;
      expect(new Ctor("boom")).toBeInstanceOf(Base);
    }
  });
});

describe("the memory contract is reachable as values from ./core", () => {
  const constants = [
    "MEMORY_SYSTEMS",
    "MEMORY_TYPES",
    "MEMORY_SEGMENTS",
    "MEMORY_STORE_SCOPES",
    "MEMORY_LIST_SCOPES",
    "MEMORY_STATUSES",
    "MEMORY_SYSTEM",
    "MEMORY_TYPE",
    "MEMORY_SEGMENT",
    "MEMORY_STORE_SCOPE",
  ] as const;

  const guards = [
    "isMemorySystem",
    "isMemoryType",
    "isMemoryTypeForSystem",
    "isMemorySegment",
    "isMemoryStoreScope",
    "isMemoryListScope",
    "isMemoryStatus",
  ] as const;

  it.each(constants)("%s is exported as a value", (name) => {
    expect(coreEsm[name]).toBeDefined();
  });

  it.each(guards)("%s is exported as a callable guard", (name) => {
    expect(typeof coreEsm[name]).toBe("function");
  });

  it("the guards actually work through the public path", () => {
    const isMemorySegment = coreEsm.isMemorySegment as (v: string) => boolean;
    const segments = coreEsm.MEMORY_SEGMENTS as readonly string[];
    expect(segments.length).toBeGreaterThan(0);
    expect(isMemorySegment(segments[0]!)).toBe(true);
    expect(isMemorySegment("definitely-not-a-segment")).toBe(false);
  });
});

describe("tool-executor helpers and capabilities are reachable as values from ./core", () => {
  it.each([
    "TOOL_EXECUTOR_ERROR_TYPES",
    "DEFAULT_AGENT_TOOLS_CAPABILITIES",
  ])("%s is exported as a value", (name) => {
    expect(coreEsm[name]).toBeDefined();
  });

  it.each([
    "createToolExecutorError",
    "isToolExecutorError",
    "toLegacyToolExecutorErrorMessage",
  ])("%s is exported as a callable", (name) => {
    expect(typeof coreEsm[name]).toBe("function");
  });

  it("round-trips a tool executor error through the public path", () => {
    const create = coreEsm.createToolExecutorError as (input: {
      errorType: string;
      toolName: string;
      message: string;
    }) => unknown;
    const isToolExecutorError = coreEsm.isToolExecutorError as (v: unknown) => boolean;
    const toLegacy = coreEsm.toLegacyToolExecutorErrorMessage as (v: unknown) => string | null;
    const types = coreEsm.TOOL_EXECUTOR_ERROR_TYPES as readonly string[];

    const err = create({ errorType: types[0]!, toolName: "send_message", message: "nope" });
    expect(isToolExecutorError(err)).toBe(true);
    expect(isToolExecutorError({ nope: true })).toBe(false);
    expect(toLegacy(err)).toBe("nope");
  });
});

describe("the DTO surface referenced by AdapterToolsProtocol is declared on ./core", () => {
  // These are types, so they cannot be probed at runtime. Assert instead that the built
  // declaration file names each one -- the .d.ts is what a consumer's tsc actually reads.
  it("every DTO named in the public protocol signatures appears in dist/core.d.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const dts = readFileSync(
      resolve(SDK_ROOT, (pkg.exports as Record<string, Record<string, string>>)["./core"]!.types!),
      "utf-8",
    );

    const expected = [
      "MetadataMap",
      "MentionInput",
      "MentionReference",
      "ToolOperationResult",
      "PaginatedList",
      "PaginationMetadataLike",
      "ParticipantRecord",
      "PeerRecord",
      "ContactRecord",
      "MemoryRecord",
      "ToolSchemaRecord",
      "ListContactsArgs",
      "AddContactArgs",
      "RemoveContactArgs",
      "ListContactRequestsArgs",
      "RespondContactRequestArgs",
      "ContactRequestsResult",
      "ListMemoriesArgs",
      "StoreMemoryArgs",
      "PlatformMessageLike",
      "HistoryLike",
      "PreprocessorContext",
      "EventEnvelope",
      "ToolExecutorError",
      "ToolExecutorErrorType",
      "AgentToolsCapabilities",
    ];

    const missing = expected.filter((name) => !new RegExp(`\\b${name}\\b`).test(dts));
    expect(missing, `missing from dist/core.d.ts: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the ./mcp/claude subpath exposes the full Claude MCP bridge surface", () => {
  // src/mcp/claude.ts was a 6-line re-export that nothing imported: tsup builds the
  // mcp-claude entry from src/mcp/sdk.ts. It also omitted GetSystemPromptContextOptions,
  // so wiring it up would have narrowed this surface rather than widening it.
  it("still resolves the export path after the dead file was removed", async () => {
    const mod = (await import(pathToFileURL(distEntry("./mcp/claude", "import")).href)) as Mod;
    expect(typeof mod.createBandSdkMcpServer).toBe("function");
  });

  it("declares every documented symbol, including GetSystemPromptContextOptions", async () => {
    const { readFileSync } = await import("node:fs");
    const dts = readFileSync(
      resolve(
        SDK_ROOT,
        (pkg.exports as Record<string, Record<string, string>>)["./mcp/claude"]!.types!,
      ),
      "utf-8",
    );

    for (const name of [
      "createBandSdkMcpServer",
      "BandSdkMcpServer",
      "CreateBandSdkMcpServerOptions",
      "GetSystemPromptContextResult",
      "GetSystemPromptContextOptions",
    ]) {
      expect(dts.includes(name), `${name} missing from mcp-claude.d.ts`).toBe(true);
    }
  });

  it("keeps the ./mcp/claude entry in package.json#exports", () => {
    expect((pkg.exports as Record<string, unknown>)["./mcp/claude"]).toBeDefined();
  });
});
