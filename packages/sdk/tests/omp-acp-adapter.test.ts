import { describe, expect, it, vi } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { OmpACPAdapter, DEFAULT_OMP_ACP_COMMAND } from "../src/adapters/omp-acp";
import { FakeTools, findFailureEvent, makeMessage } from "./testUtils";

function mockConnection(options: {
  initialize?: () => Promise<{ protocolVersion: number; agentCapabilities: Record<string, never> }>;
  prompt?: () => Promise<{ stopReason: string }>;
} = {}) {
  const controller = new AbortController();
  return {
    connection: {
      signal: controller.signal,
      closed: new Promise<void>(() => undefined),
      initialize: options.initialize ?? vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} })),
      authenticate: vi.fn(async () => ({})),
      newSession: vi.fn(async () => ({ sessionId: "session-1" })),
      prompt: options.prompt ?? vi.fn(async () => ({ stopReason: "end_turn" })),
    } as never,
    stop: async () => controller.abort(),
  };
}

// The private fields a thin `OmpACPAdapter` wrapper must forward unchanged to
// `ACPClientAdapter` — asserting real behavior of the wrapper (does it forward
// faithfully) without re-testing `ACPClientAdapter`'s own protocol handling.
interface ExposedOptions {
  cwd: string;
  env?: Record<string, string>;
  clientCapabilities?: unknown;
  resolvePermission?: unknown;
  resolveSessionMode?: unknown;
  resolveSessionModel?: unknown;
  mcpServers: unknown[];
  enableMcpTools: boolean;
  enableMemoryTools: boolean;
  additionalMcpTools: unknown[];
  authMethod?: string | null;
  permissionTimeoutMs: number;
  turnTimeoutMs: number;
}

describe("OmpACPAdapter", () => {
  it("defaults the command to omp acp", async () => {
    let command: string[] | null = null;
    const adapter = new OmpACPAdapter({
      connectionFactory: async (_client, options) => {
        command = options.command;
        return mockConnection();
      },
    });

    await adapter.onStarted("Agent", "desc");
    expect(command).toEqual(["omp", "acp"]);
    expect(DEFAULT_OMP_ACP_COMMAND).toEqual(["omp", "acp"]);
    await adapter.stop();
  });

  it("forwards an explicit command verbatim instead of merging it with the default", async () => {
    let command: string[] | null = null;
    const adapter = new OmpACPAdapter({
      command: ["omp", "acp", "--model", "google/gemini-2.5-flash"],
      connectionFactory: async (_client, options) => {
        command = options.command;
        return mockConnection();
      },
    });

    await adapter.onStarted("Agent", "desc");
    expect(command).toEqual(["omp", "acp", "--model", "google/gemini-2.5-flash"]);
    await adapter.stop();
  });

  it("forwards every option identity-unchanged, with no OMP-specific default for clientCapabilities", () => {
    const clientCapabilities = { fs: { readTextFile: true } };
    const resolvePermission = vi.fn();
    const resolveSessionMode = vi.fn();
    const resolveSessionModel = vi.fn();
    const mcpServers = [{ name: "custom", command: "custom-mcp" }] as never[];
    const additionalMcpTools = [{ name: "extra-tool" }] as never[];

    const adapter = new OmpACPAdapter({
      cwd: "/work",
      env: { GEMINI_API_KEY: "secret" },
      clientCapabilities,
      resolvePermission,
      resolveSessionMode,
      resolveSessionModel,
      mcpServers,
      enableMcpTools: false,
      enableMemoryTools: true,
      additionalMcpTools,
      authMethod: "test-auth-method",
      permissionTimeoutMs: 12_345,
      turnTimeoutMs: 999_999,
    });

    const exposed = adapter as unknown as ExposedOptions;
    expect(exposed.cwd).toBe("/work");
    expect(exposed.env).toEqual({ GEMINI_API_KEY: "secret" });
    expect(exposed.clientCapabilities).toBe(clientCapabilities);
    expect(exposed.resolvePermission).toBe(resolvePermission);
    expect(exposed.resolveSessionMode).toBe(resolveSessionMode);
    expect(exposed.resolveSessionModel).toBe(resolveSessionModel);
    expect(exposed.mcpServers).toEqual(mcpServers);
    expect(exposed.enableMcpTools).toBe(false);
    expect(exposed.enableMemoryTools).toBe(true);
    expect(exposed.additionalMcpTools).toEqual(additionalMcpTools);
    expect(exposed.authMethod).toBe("test-auth-method");
    expect(exposed.permissionTimeoutMs).toBe(12_345);
    expect(exposed.turnTimeoutMs).toBe(999_999);
  });

  it("leaves clientCapabilities undefined when omitted, never defaulting to fs/terminal support", async () => {
    const initialize = vi.fn(async () => ({ protocolVersion: 1, agentCapabilities: {} }));
    const adapter = new OmpACPAdapter({
      connectionFactory: async () => mockConnection({ initialize }),
    });

    await adapter.onStarted("Agent", "desc");
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ clientCapabilities: {} }));
    await adapter.stop();
  });

  it("reports failures as omp-acp", async () => {
    const adapter = new OmpACPAdapter({
      enableMcpTools: false,
      connectionFactory: async () =>
        mockConnection({
          prompt: async () => {
            throw new Error("OMP failed");
          },
        }),
    });
    const tools = new FakeTools();

    await adapter.onStarted("Agent", "desc");
    await expect(
      adapter.onMessage(
        makeMessage("hi"),
        tools,
        { roomToSession: {} },
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-1" },
      ),
    ).rejects.toThrow("OMP failed");

    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "omp-acp",
      message: "OMP failed",
    });
    await adapter.stop();
  });

  it("is an instance of ACPClientAdapter", () => {
    expect(new OmpACPAdapter() instanceof ACPClientAdapter).toBe(true);
  });
});
