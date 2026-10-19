import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { trackTurn, type TurnTools } from "../src/core/turn";

import {
  ClaudeSDKAdapter,
  type ClaudeSDKAdapterOptions,
  type ClaudeSDKQueryParams,
  type ClaudeSDKQuery,
} from "../src/adapters/claude-sdk/ClaudeSDKAdapter";
import { HistoryProvider } from "../src/runtime/types";
import { DeliveryFailedError } from "../src/core/deliveryFailedError";
import { RestFacade } from "../src/client/rest/RestFacade";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { FakeRestApi, FakeTools, findFailureEvent, makeMessage, makeRoster, expectTurnFailed, MISSING_REPLY, reportedFailures } from "./testUtils";
import { describeDeliveryContract } from "./deliveryContract";
import { MCP_SERVER_NAME, NO_REPLY_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import type { AdapterToolsProtocol, FrameworkAdapterInput } from "../src/contracts/protocols";
import { createDeferred } from "../src/core/deferred";
import { BandPlatform, person, AGENT_ID, AGENT_API_KEY } from "./flows/support/bandPlatform";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { BandLink } from "../src/platform/BandLink";
import { activitySequence, recordRuntimeActivity } from "./support/activityReports";
import { activityWhileProviderFails } from "./support/providerFailure";
import { CLOSING_TEXT, describeCustomToolEffect, describeTurnOutcomeContract, turnInput, type TurnScript, NO_REPLY_ARGS, TOOL_REPLY_ARGS, ACT_TOOL, ACT_ARGS } from "./turnOutcomeContract";

/** What the MCP client throws once the query-owned server is closed. */
const TRANSPORT_CLOSED = /Not connected|Connection closed/;

/** Serves buffered items before surfacing a failure, as the SDK's own stream does, so an abort leaves them to be read. */
class BufferedStream<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private error?: Error;
  private waiter?: { resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void };

  public enqueue(value: T): void {
    if (this.waiter) {
      const { resolve } = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value });
    } else this.queue.push(value);
  }

  public fail(error: Error): void {
    this.error = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) return Promise.resolve({ done: false, value: this.queue.shift()! });
        if (this.error) return Promise.reject(this.error);
        return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
      },
    };
  }
}

function streamFrom<T>(items: T[]): AsyncGenerator<T, void> {
  return (async function* generator(): AsyncGenerator<T, void> {
    for (const item of items) {
      yield item;
    }
  })();
}

type ClaudeOptions = ClaudeSDKQueryParams["options"];

/** Fires the hook the adapter registered for `event`, as the SDK does, with the base input every hook carries. */
async function callHook(options: ClaudeOptions, event: keyof NonNullable<NonNullable<ClaudeOptions>["hooks"]>, input: Record<string, unknown>): Promise<void> {
  const hook = options?.hooks?.[event]?.[0]?.hooks[0];
  expect(hook).toBeDefined();
  expect(await hook!({ hook_event_name: event, session_id: "session", cwd: "/tmp", transcript_path: "/tmp/transcript", ...input } as never,
    undefined, { signal: new AbortController().signal })).toEqual({});
}

/** Runs `fire` and waits for the report it causes, so the next step cannot coalesce into it. */
async function reported(reports: ReturnType<typeof recordRuntimeActivity>, kind: string, fire: () => Promise<void> | void): Promise<void> {
  const from = reports.entries.length;
  await fire();
  await reports.next((entry) => entry.activity?.kind === kind, from);
}

describe("Claude scoped activity", () => {
  it("observes raw additional MCP tools through native hooks without portable effect credit", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const reports = recordRuntimeActivity();
    const adapter = new ClaudeSDKAdapter({ enableExecutionReporting: false,
      additionalMcpTools: [{ name: "native_lookup", description: "Raw lookup",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        execute: async ({ query }) => {
          expect(query).toBe("private-raw-marker");
          entered.resolve();
          await release.promise;
          return { content: [{ type: "text", text: "native result" }] };
        },
      }],
      queryFn: async function* ({ options }) {
        const server = options!.mcpServers![MCP_SERVER_NAME] as McpSdkServerConfigWithInstance;
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        const client = new Client({ name: "raw-mcp-test", version: "1" });
        onTestFinished(() => client.close());
        await client.connect(clientTransport);
        const invoke = (event: "PreToolUse" | "PostToolUse") => callHook(options, event, {
          tool_name: "mcp__band__native_lookup", tool_input: { query: "private-raw-marker" }, tool_response: "native result", tool_use_id: "raw-call",
        });
        await invoke("PreToolUse");
        expect(await client.callTool({ name: "native_lookup", arguments: { query: "private-raw-marker" } })).toMatchObject({ content: [{ type: "text", text: "native result" }] });
        await invoke("PostToolUse");
        yield { type: "result", subtype: "success", result: "" } as never;
      },
    });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    const message = await session.room.say("owner", "look up status");
    try {
      await entered.promise;
      await reports.next((entry) => entry.activity?.kind === "tool_call" && entry.activity.name === "mcp__band__native_lookup");
      release.resolve();
      expect(await session.room.outcome(message)).toBe("failed");
      expect(session.room.failures).toEqual([MISSING_REPLY]);
      expect(session.room.messages).toEqual([]);
      expect(activitySequence(reports)).toEqual([
        { kind: "reasoning" }, { kind: "tool_call", name: "mcp__band__native_lookup" }, { kind: "reasoning" }, false,
      ]);
      expect([...session.room.events("tool_call"), ...session.room.events("tool_result")]).toEqual([]);
      expect(JSON.stringify(reports.entries)).not.toContain("private-raw-marker");
    } finally { release.resolve(); }
  });

  it("uses actual query-bound custom and Band MCP execution without duplicate native observations", async () => {
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    const reports = recordRuntimeActivity();
    const adapter = new ClaudeSDKAdapter({ enableExecutionReporting: false,
      customTools: [{ name: "lookup_status", schema: z.object({ query: z.string() }), handler: async ({ query }) => {
        expect(query).toBe("private-mcp-marker");
        await release.promise;
        return "ready";
      } }],
      queryFn: async function* ({ options }) {
        const server = options!.mcpServers![MCP_SERVER_NAME] as McpSdkServerConfigWithInstance;
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        const client = new Client({ name: "scoped-mcp-test", version: "1" });
        onTestFinished(() => client.close());
        await client.connect(clientTransport);
        const invoke = (event: "PreToolUse" | "PostToolUse", name: string) => callHook(options, event, {
          tool_name: `mcp__band__${name}`, tool_input: {}, tool_response: "ready", tool_use_id: name,
        });
        await invoke("PreToolUse", "lookup_status");
        const custom = await client.callTool({ name: "lookup_status", arguments: { room_id: "room-1", query: "private-mcp-marker" } });
        expect(custom.isError).toBeUndefined();
        expect(JSON.stringify(custom.content)).toContain("ready");
        await invoke("PostToolUse", "lookup_status");
        await invoke("PreToolUse", "band_get_participants");
        const band = await client.callTool({ name: "band_get_participants", arguments: { room_id: "room-1" } });
        expect(band.isError).toBeUndefined();
        expect(JSON.stringify(band.content)).toContain("owner");
        await invoke("PostToolUse", "band_get_participants");
        yield { type: "result", subtype: "success", result: "Done." } as never;
      },
    });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    const message = await session.room.say("owner", "look up status");
    await reports.next((entry) => entry.activity?.kind === "tool_call" && entry.activity.name === "lookup_status");
    release.resolve();
    expect(await session.room.outcome(message)).toBe("processed");
    expect(activitySequence(reports)).toEqual([
      { kind: "reasoning" }, { kind: "tool_call", name: "lookup_status" }, { kind: "reasoning" },
      { kind: "tool_call", name: "band_get_participants" }, { kind: "reasoning" }, false,
    ]);
    expect(session.room.messages.map(({ content }) => content)).toEqual(["Done."]);
    expect([...session.room.events("tool_call"), ...session.room.events("tool_result")]).toEqual([]);
    expect(JSON.stringify(reports.entries)).not.toContain("private-mcp-marker");
  });

  it("aborts and closes query-owned MCP on forced reset before admitting a replacement", async () => {
    const started = [createDeferred(), createDeferred()];
    const releases = [createDeferred(), createDeferred()];
    const finished = [createDeferred(), createDeferred()];
    const options: NonNullable<ClaudeSDKQueryParams["options"]>[] = [];
    const clients: Client[] = [];
    const adapter = new ClaudeSDKAdapter({ queryFn: async function* (params) {
      const index = options.push(params.options!) - 1;
      started[index]!.resolve();
      try {
        await releases[index]!.promise;
        if (params.options?.abortController?.signal.aborted) throw new Error("query aborted");
        yield { type: "result", subtype: "success", result: "Done." } as never;
      } finally { finished[index]!.resolve(); }
    } });
    await using platform = BandPlatform.host([person("owner")]);
    const runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    });
    onTestFinished(async () => {
      releases.forEach((release) => release.resolve());
      await Promise.all(finished.slice(0, options.length).map((done) => done.promise));
      await runtime.stop(0);
      await Promise.all(clients.map((client) => client.close()));
    });
    const connect = async (index: number) => {
      const server = options[index]!.mcpServers![MCP_SERVER_NAME] as McpSdkServerConfigWithInstance;
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      const client = new Client({ name: "query-cleanup-test", version: "1" });
      clients.push(client);
      await client.connect(clientTransport);
      return client;
    };
    await runtime.start(adapter);
    const room = await platform.room("room");
    await room.say("owner", "first");
    await started[0]!.promise;
    const first = await connect(0);
    expect((await first.listTools()).tools.length).toBeGreaterThan(0);
    await runtime.resetRoomSession("room", 0);
    expect(options[0]!.abortController!.signal.aborted).toBe(true);
    await expect(first.listTools()).rejects.toThrow(TRANSPORT_CLOSED);
    await room.say("owner", "replacement");
    await started[1]!.promise;
    const second = await connect(1);
    expect((await second.listTools()).tools.length).toBeGreaterThan(0);
    await runtime.stop(0);
    expect(options[1]!.abortController!.signal.aborted).toBe(true);
    await expect(second.listTools()).rejects.toThrow(TRANSPORT_CLOSED);
  });

  it("ends a turn retired by a forced reset without writing into the room", async () => {
    const started = createDeferred();
    const adapter = new ClaudeSDKAdapter({ queryFn: async function* (params) {
      started.resolve();
      const signal = params.options!.abortController!.signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" });
      yield undefined as never;
    } });
    const turns: Promise<void>[] = [];
    const onMessage = adapter.onMessage.bind(adapter);
    adapter.onMessage = (...args) => { const turn = onMessage(...args); turns.push(turn); return turn; };
    await using platform = BandPlatform.host([person("owner")]);
    const runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    });
    onTestFinished(async () => { await runtime.stop(0); });
    await runtime.start(adapter);
    const room = await platform.room("room");
    await room.say("owner", "first");
    await started.promise;
    const posted = platform.rest.posted.entries.length;
    await runtime.resetRoomSession("room", 0);
    await Promise.all(turns);
    expect(platform.rest.posted.entries.slice(posted)).toEqual([]);
  });

  it("keeps a turn retired by a forced reset from writing events it had buffered", async () => {
    const resumes: Array<string | undefined> = [];
    const adapter = new ClaudeSDKAdapter({ enableExecutionReporting: true, queryFn: ({ options }) => {
      resumes.push(options!.resume);
      const stream = new BufferedStream<unknown>();
      if (resumes.length === 1) {
        stream.enqueue({ type: "tool_use_summary", summary: "ran a tool", preceding_tool_use_ids: [] });
        stream.enqueue({ type: "assistant", session_id: "old-session", message: { content: [{ type: "text", text: "partial" }] } });
        options!.abortController!.signal.addEventListener("abort", () => {
          stream.fail(Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" }));
        }, { once: true });
      } else stream.enqueue({ type: "result", subtype: "success", result: "fresh", session_id: "new-session" });
      return stream as never;
    } });
    const turns: Promise<void>[] = [];
    const onMessage = adapter.onMessage.bind(adapter);
    adapter.onMessage = (...args) => { const turn = onMessage(...args); turns.push(turn); return turn; };
    await using platform = BandPlatform.host([person("owner")]);
    const writing = createDeferred();
    const gate = createDeferred();
    let held = false;
    const createChatEvent = platform.rest.createChatEvent.bind(platform.rest);
    platform.rest.createChatEvent = async (roomId, event) => {
      if (!held) { held = true; writing.resolve(); await gate.promise; }
      return await createChatEvent(roomId, event);
    };
    const runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    });
    onTestFinished(async () => { gate.resolve(); await runtime.stop(0); });
    await runtime.start(adapter);
    const room = await platform.room("room");
    await room.say("owner", "first");
    await writing.promise;
    const posted = platform.rest.posted.entries.length;
    await runtime.resetRoomSession("room", 0);
    gate.resolve();
    await Promise.all(turns);
    expect(platform.rest.posted.entries.slice(posted).filter((entry) => entry.messageType === "task")).toEqual([]);
    await room.say("owner", "second");
    await room.until(() => resumes.length === 2);
    expect(resumes[1]).toBeUndefined();
  });

  it("keeps a turn retired while its reply is being posted from reporting its failure", async () => {
    const adapter = new ClaudeSDKAdapter({ queryFn: async function* () {
      yield { type: "assistant", session_id: "session", message: { content: [{ type: "text", text: "partial answer" }] } } as never;
      yield { type: "result", subtype: "error_max_turns", is_error: true, session_id: "session", errors: ["max turns reached"] } as never;
    } });
    const turns: Promise<void>[] = [];
    const onMessage = adapter.onMessage.bind(adapter);
    adapter.onMessage = (...args) => { const turn = onMessage(...args); turns.push(turn); return turn; };
    await using platform = BandPlatform.host([person("owner")]);
    const runtime = new PlatformRuntime({ agentId: AGENT_ID, apiKey: AGENT_API_KEY,
      link: new BandLink({ agentId: AGENT_ID, apiKey: AGENT_API_KEY, ...platform.link }),
    });
    await runtime.start(adapter);
    const room = await platform.room("room");
    const reply = room.holdMessage((content) => content.includes("partial answer"));
    onTestFinished(async () => { reply.release(); await runtime.stop(0); });
    await room.say("owner", "first");
    await reply.sending;
    const posted = platform.rest.posted.entries.length;
    await runtime.resetRoomSession("room", 0);
    reply.release();
    await Promise.all(turns);
    expect(platform.rest.posted.entries.slice(posted).filter((entry) => entry.messageType === "error")).toEqual([]);
  });

  it("logs a failed query-owned MCP close with its room and keeps the completed turn's outcome", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const adapter = new ClaudeSDKAdapter({ logger, queryFn: async function* (params) {
      const server = params.options!.mcpServers![MCP_SERVER_NAME] as McpSdkServerConfigWithInstance;
      vi.spyOn(server.instance, "close").mockRejectedValueOnce(new Error("close failed"));
      yield { type: "result", subtype: "success", result: "Done." } as never;
    } });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    const message = await session.room.say("owner", "hello");
    expect(await session.room.outcome(message)).toBe("processed");
    expect(session.room.messages.map(({ content }) => content)).toEqual(["Done."]);
    expect(logger.warn).toHaveBeenCalledWith("Claude SDK MCP bridge close failed", expect.objectContaining({ roomId: session.room.id }));
  });

  it("ends a native tool at its failure hook", async () => {
    const reports = recordRuntimeActivity();
    const tool = { tool_name: "Bash", tool_input: { command: "private-marker" }, tool_use_id: "native" };
    const adapter = new ClaudeSDKAdapter({ enableMcpTools: false, enableExecutionReporting: false,
      queryFn: async function* ({ options }) {
        await reported(reports, "tool_call", () => callHook(options, "PreToolUse", tool));
        await reported(reports, "reasoning", () => callHook(options, "PostToolUseFailure", { ...tool, error: "failed", is_interrupt: false }));
        yield { type: "result", subtype: "success", result: "Done.", session_id: "session" } as never;
      },
    });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    expect(await session.room.outcome(await session.room.say("owner", "run it"))).toBe("processed");
    expect(activitySequence(reports)).toEqual([{ kind: "reasoning" }, { kind: "tool_call", name: "Bash" }, { kind: "reasoning" }, false]);
    expect(session.room.messages.map(({ content }) => content)).toEqual(["Done."]);
    expect([...session.room.events("tool_call"), ...session.room.events("tool_result")]).toEqual([]);
    expect(JSON.stringify(reports.entries)).not.toContain("private-marker");
  });

  it.each(["failed", "success"] as const)("ends a compaction the CLI reports %s, with or without a PostCompact", async (result) => {
    const reports = recordRuntimeActivity();
    const compacted = { type: "system", subtype: "status", status: null, compact_result: result, uuid: "status", session_id: "session" };
    const adapter = new ClaudeSDKAdapter({ enableMcpTools: false, enableExecutionReporting: false,
      queryFn: async function* ({ options }) {
        await reported(reports, "memory", () => callHook(options, "PreCompact", { trigger: "auto", custom_instructions: null }));
        const from = reports.entries.length;
        yield compacted as never;
        await reports.next((entry) => entry.activity?.kind === "reasoning", from);
        await reported(reports, "memory", () => callHook(options, "PreCompact", { trigger: "auto", custom_instructions: null }));
        yield { type: "result", subtype: "success", result: "Done.", session_id: "session" } as never;
      },
    });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    expect(await session.room.outcome(await session.room.say("owner", "run it"))).toBe("processed");
    expect(activitySequence(reports)).toEqual([{ kind: "reasoning" }, { kind: "memory" }, { kind: "reasoning" }, { kind: "memory" }, { kind: "reasoning" }, false]);
  });

  it("ends a native tool whose call was denied, which runs no hook after it", async () => {
    const reports = recordRuntimeActivity();
    const adapter = new ClaudeSDKAdapter({ enableMcpTools: false, enableExecutionReporting: false,
      queryFn: async function* ({ options }) {
        await reported(reports, "tool_call", () => callHook(options, "PreToolUse", { tool_name: "Bash", tool_input: {}, tool_use_id: "denied" }));
        const from = reports.entries.length;
        yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "denied", is_error: true, content: "Permission denied" }] } } as never;
        await reports.next((entry) => entry.activity?.kind === "reasoning", from);
        yield { type: "result", subtype: "success", result: "Done.", session_id: "session" } as never;
      },
    });
    await using session = await BandPlatform.join(adapter, [person("owner")]);
    expect(await session.room.outcome(await session.room.say("owner", "run it"))).toBe("processed");
    expect(activitySequence(reports)).toEqual([
      { kind: "reasoning" }, { kind: "tool_call", name: "Bash" }, { kind: "reasoning" }, false,
    ]);
  });

  it("ends a native tool the query left open before its failure is delivered", async () => {
    const reports = recordRuntimeActivity();
    const adapter = new ClaudeSDKAdapter({ enableMcpTools: false, enableExecutionReporting: false,
      queryFn: async function* ({ options }) {
        await reported(reports, "tool_call", () => callHook(options, "PreToolUse", { tool_name: "Bash", tool_input: {}, tool_use_id: "open" }));
        throw new Error("provider died");
        yield undefined as never;
      },
    });
    expect(await activityWhileProviderFails(adapter, { reports })).toEqual({ kind: "reasoning" });
  });
});

describe("ClaudeSDKAdapter", () => {
  it("uses the stable query API and resumes by session id", async () => {
    const calls: ClaudeSDKQueryParams[] = [];
    let turn = 0;

    const queryFn: ClaudeSDKQuery = ({ prompt, options }) => {
      calls.push({ prompt, options });
      turn += 1;

      if (turn === 1) {
        return streamFrom([
          {
            type: "assistant",
            session_id: "session-1",
            message: {
              content: [{ type: "text", text: "first response" }],
            },
          } as never,
          {
            type: "result",
            subtype: "success",
            result: "first response",
            session_id: "session-1",
          } as never,
        ]) as never;
      }

      return streamFrom([
        {
          type: "assistant",
          session_id: "session-1",
          message: {
            content: [{ type: "text", text: "second response" }],
          },
        } as never,
        {
          type: "result",
          subtype: "success",
          result: "second response",
          session_id: "session-1",
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({
      queryFn,
      model: "claude-sonnet-4-6",
      permissionMode: "acceptEdits",
    });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    const bootstrapHistory = new HistoryProvider([
      {
        sender_name: "Alice",
        sender_type: "User",
        content: "historic context",
      },
    ]);

    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      bootstrapHistory,
      "Participants changed",
      "Contacts updated",
      { isSessionBootstrap: true, roomId: "room-1" },
    );
    await adapter.onMessage(
      makeMessage("follow up"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-1" },
    );

    expect(tools.messages).toEqual(["first response", "second response"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.model).toBe("claude-sonnet-4-6");
    expect(calls[0]?.options?.permissionMode).toBe("acceptEdits");
    expect(calls[0]?.options?.systemPrompt).toBeTypeOf("string");
    expect(calls[0]?.options?.mcpServers).toBeTruthy();
    expect(Object.keys(calls[0]?.options?.mcpServers ?? {})).toEqual([MCP_SERVER_NAME]);
    expect(Array.isArray(calls[0]?.options?.allowedTools)).toBe(true);
    expect(calls[0]?.prompt).toContain("[Previous conversation context]");
    expect(calls[0]?.prompt).toContain("[System]: Participants changed");
    expect(calls[0]?.prompt).toContain("[System]: Contacts updated");
    expect(calls[0]?.prompt).toContain("room_id=\"room-1\"");
    expect(calls[1]?.options?.resume).toBe("session-1");
  });

  describe("isolation from the host's Claude Code", () => {
    /** The options the adapter's first query was started with. */
    async function firstQueryOptions(options: ClaudeSDKAdapterOptions = {}): Promise<ClaudeSDKQueryParams["options"]> {
      let captured: ClaudeSDKQueryParams["options"];
      const queryFn: ClaudeSDKQuery = ({ options: queryOptions }) => {
        captured = queryOptions;
        return streamFrom([]);
      };
      const adapter = new ClaudeSDKAdapter({ ...options, queryFn });
      await adapter.onStarted("Isolated Agent", "Isolation test agent");
      await adapter.onMessage(makeMessage("hello"), new FakeTools(), new HistoryProvider([]), null, null, {
        isSessionBootstrap: false,
        roomId: "room-1",
      });
      return captured;
    }

    it("loads no host settings, denies cross-session tools and tool search, refuses inbound peers, and disables claude.ai connectors by default", async () => {
      const options = await firstQueryOptions();

      expect(options?.settingSources).toEqual([]);
      // Spelled out, not the adapter's constants: the contract must fail if a constant loses an entry.
      expect(options?.disallowedTools).toEqual(["ListAgents", "SendMessage", "SendFile", "ToolSearch"]);
      expect(options?.settings).toMatchObject({ crossSessionInbound: "refuse", disableClaudeAiConnectors: true });
    });

    it("forwards the caller's settingSources unchanged", async () => {
      const options = await firstQueryOptions({ settingSources: ["user"] });

      expect(options?.settingSources).toEqual(["user"]);
    });
  });

  it("reports tool summary events when execution reporting is enabled", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "tool_use_summary",
          summary: "Used band_send_message",
          preceding_tool_use_ids: ["tool-1"],
          session_id: "session-2",
        } as never,
        {
          type: "assistant",
          session_id: "session-2",
          message: {
            content: [{ type: "text", text: "done" }],
          },
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({
      queryFn,
      enableExecutionReporting: true,
    });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("run a tool"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-2" },
    );

    expect(tools.messages).toEqual(["done"]);
    const toolCallEvents = tools.events.filter((event) => event.messageType === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    const payload = JSON.parse(toolCallEvents[0]?.content ?? "{}");
    expect(payload.type).toBe("tool_use_summary");
    expect(payload.summary).toBe("Used band_send_message");
  });

  it("rehydrates session id from bootstrap task metadata without prompting it", async () => {
    const calls: ClaudeSDKQueryParams[] = [];
    const queryFn: ClaudeSDKQuery = ({ prompt, options }) => {
      calls.push({ prompt, options });
      return streamFrom([
        {
          type: "assistant",
          session_id: "session-from-history",
          message: {
            content: [{ type: "text", text: "ok" }],
          },
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello"),
      tools,
      new HistoryProvider([
        {
          message_type: "task",
          content: "Claude SDK session",
          metadata: {
            claude_sdk_session_id: "session-from-history",
          },
        },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-9" },
    );

    expect(calls[0]?.options?.resume).toBe("session-from-history");
    expect(calls[0]?.prompt).not.toContain("[Previous conversation context]");
    expect(calls[0]?.prompt).not.toContain("Claude SDK session");
    expect(calls[0]?.prompt).not.toContain("session-from-history");
    expect(tools.events.some((event) => event.messageType === "task")).toBe(true);
  });

  it("prompts only text history on bootstrap and keeps session resume off the prompt", async () => {
    const calls: ClaudeSDKQueryParams[] = [];
    const queryFn: ClaudeSDKQuery = ({ prompt, options }) => {
      calls.push({ prompt, options });
      return streamFrom([
        {
          type: "assistant",
          session_id: "session-from-history",
          message: {
            content: [{ type: "text", text: "ok" }],
          },
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    await adapter.onMessage(
      makeMessage("hello"),
      new FakeTools(),
      new HistoryProvider([
        { sender_name: "Alice", message_type: "text", content: "typed text" },
        { sender_name: "Bob", content: "legacy text" },
        {
          message_type: "task",
          content: "Claude SDK session",
          metadata: { claude_sdk_session_id: "session-from-history" },
        },
        { message_type: "tool_call", content: JSON.stringify({ type: "tool_use_summary" }) },
        { message_type: "tool_result", content: "tool output" },
        { message_type: "thought", content: "internal reasoning" },
        { message_type: "error", content: "provider error" },
        { message_type: "unknown", content: "unrecognized content" },
        { sender_name: "Carol", message_type: "text", content: "after non-text" },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-mixed" },
    );

    const prompt = calls[0]?.prompt ?? "";
    expect(calls[0]?.options?.resume).toBe("session-from-history");
    expect(prompt).toContain("[Previous conversation context]");
    expect(prompt).toContain("[Alice]: typed text");
    expect(prompt).toContain("[Bob]: legacy text");
    expect(prompt).toContain("[Carol]: after non-text");
    expect(prompt).not.toContain("Claude SDK session");
    expect(prompt).not.toContain("session-from-history");
    expect(prompt).not.toContain("tool_use_summary");
    expect(prompt).not.toContain("tool output");
    expect(prompt).not.toContain("internal reasoning");
    expect(prompt).not.toContain("provider error");
    expect(prompt).not.toContain("unrecognized content");
  });

  it("rehydrates legacy Claude session markers from bootstrap task metadata", async () => {
    const calls: Array<Pick<ClaudeSDKQueryParams, "options">> = [];
    const queryFn: ClaudeSDKQuery = ({ options }) => {
      calls.push({ options });
      return streamFrom([
        {
          type: "assistant",
          session_id: "session-from-history",
          message: {
            content: [{ type: "text", text: "ok" }],
          },
        } as never,
      ]) as never;
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    await adapter.onMessage(
      makeMessage("hello"),
      new FakeTools(),
      new HistoryProvider([
        {
          message_type: "task",
          metadata: {
            claude_session_id: "legacy-session-from-history",
          },
        },
      ]),
      null,
      null,
      { isSessionBootstrap: true, roomId: "room-legacy" },
    );

    expect(calls[0]?.options?.resume).toBe("legacy-session-from-history");
  });

  it("logs session marker failures and continues responding", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "assistant",
          session_id: "session-logger",
          message: {
            content: [{ type: "text", text: "still answered" }],
          },
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({
      queryFn,
      enableMcpTools: false,
      logger,
    });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools({ failOn: ["sendEvent"] });
    await adapter.onMessage(
      makeMessage("hello", "room-log"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-log" },
    );

    expect(tools.messages).toEqual(["still answered"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Claude SDK session marker event failed",
      expect.objectContaining({
        roomId: "room-log",
        sessionId: "session-logger",
      }),
    );
  });

  it("surfaces a query-loop failure as a structured sendFailure event", async () => {
    const queryFn: ClaudeSDKQuery = () => {
      throw new Error("claude query blew up");
    };

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-fail"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-fail" },
    ));

    expect(tools.messages).toEqual([]);
    const failureEvent = findFailureEvent(tools);
    expect(failureEvent?.content).toBe("claude query blew up");
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      message: "claude query blew up",
      code: null,
      detail: null,
    });
  });


  it("reports a non-success result event as a terminal provider failure without prior assistant text", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "result",
          subtype: "error_max_turns",
          errors: ["hit the turn cap"],
          session_id: "session-fail",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-result-fail"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-result-fail" },
    ));

    expect(tools.messages).toEqual([]);
    const failureEvent = findFailureEvent(tools);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error_max_turns",
      message: "hit the turn cap",
    });
  });

  it("keeps preceding assistant text once, then fails the turn on a non-success result", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "assistant",
          session_id: "session-partial",
          message: {
            content: [{ type: "text", text: "almost done" }],
          },
        } as never,
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["tool crashed"],
          session_id: "session-partial",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-result-partial"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-result-partial" },
    ));

    expect(tools.messages).toEqual(["almost done"]);
    const failureEvent = findFailureEvent(tools);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(failureEvent?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error_during_execution",
      message: "tool crashed",
    });
  });

  it("reports the Claude result failure even when partial-text delivery is rejected", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "assistant",
          session_id: "session-partial-delivery",
          message: {
            content: [{ type: "text", text: "almost done" }],
          },
        } as never,
        {
          type: "result",
          subtype: "error_during_execution",
          errors: ["tool crashed"],
          session_id: "session-partial-delivery",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools({ failOn: ["sendMessage"] });
    await expect(adapter.onMessage(
      makeMessage("hello", "room-result-partial-delivery"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-result-partial-delivery" },
    )).rejects.toBeInstanceOf(DeliveryFailedError);
    expect(tools.messages).toEqual([]);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error_during_execution",
      message: "tool crashed",
    });
  });

  it("treats success+is_error as a terminal Claude failure and does not deliver the result", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in",
          session_id: "session-is-error",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await expectTurnFailed(adapter.onMessage(
      makeMessage("hello", "room-is-error"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-is-error" },
    ));

    expect(tools.messages).toEqual([]);
    expect(tools.events.filter((event) => event.messageType === "error")).toHaveLength(1);
    expect(findFailureEvent(tools)?.metadata?.failure).toMatchObject({
      provider: "claude-sdk",
      code: "error",
      message: "Not logged in",
    });
  });

  it("still delivers a success result when is_error is false", async () => {
    const queryFn: ClaudeSDKQuery = () =>
      streamFrom([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "all good",
          session_id: "session-is-error-false",
        } as never,
      ]) as never;

    const adapter = new ClaudeSDKAdapter({ queryFn });
    await adapter.onStarted("Parity Agent", "Parity test agent");

    const tools = new FakeTools();
    await adapter.onMessage(
      makeMessage("hello", "room-is-error-false"),
      tools,
      new HistoryProvider([]),
      null,
      null,
      { isSessionBootstrap: false, roomId: "room-is-error-false" },
    );

    expect(tools.messages).toEqual(["all good"]);
    expect(tools.events.filter((event) => event.messageType === "error")).toEqual([]);
  });

  describe("a turn's Band tool calls through the MCP bridge", () => {
    const ROOM_ID = "room-send";
    const SENDER = makeMessage("hello", ROOM_ID);

    /** Real Band tools over a fake REST API, recording every message that reaches the room. */
    function recordingRoomTools(): { tools: AgentTools; posted: string[] } {
      const posted: string[] = [];
      const api = new FakeRestApi({
        createChatMessage: async (_roomId, message) => {
          posted.push(message.content);
          return {};
        },
      });
      const roster = makeRoster([{ id: SENDER.senderId, handle: "@user", name: "User", type: "User" }]);
      return { tools: new AgentTools({ roomId: ROOM_ID, rest: new RestFacade({ api }), roster }), posted };
    }

    function roomTurn(tools: AdapterToolsProtocol): FrameworkAdapterInput {
      return {
        message: SENDER,
        tools,
        history: new HistoryProvider([]),
        participantsMessage: null,
        contactsMessage: null,
        isSessionBootstrap: false,
        roomId: ROOM_ID,
      };
    }

    const connections = new Map<McpSdkServerConfigWithInstance["instance"], Promise<Client>>();

    /** Claude Code's one connection to an adapter's Band MCP server, opened on first use and closed with the test. */
    function connectionTo(server: McpSdkServerConfigWithInstance): Promise<Client> {
      const open = connections.get(server.instance) ?? (async () => {
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        const client = new Client({ name: "claude-code-stand-in", version: "1.0.0" });
        await client.connect(clientTransport);
        onTestFinished(async () => {
          connections.delete(server.instance);
          await client.close();
        });
        return client;
      })();
      connections.set(server.instance, open);
      return open;
    }

    async function callMcpTool(options: ClaudeSDKQueryParams["options"], name: string, args: Record<string, unknown>) {
      const client = await connectionTo(options?.mcpServers?.[MCP_SERVER_NAME] as McpSdkServerConfigWithInstance);
      return client.callTool({ name, arguments: args });
    }

    type McpResult = Awaited<ReturnType<typeof callMcpTool>>;

    function startMessage(adapter: ClaudeSDKAdapter, tools: TurnTools, roomId = ROOM_ID) {
      return adapter.onMessage(makeMessage("hello", roomId), tools, new HistoryProvider([]), null, null, { roomId, isSessionBootstrap: false });
    }

    const portable = (overrides: Partial<CustomToolDef> = {}): CustomToolDef => ({
      name: "write_marker", schema: z.object({}), handler: () => ({ ok: true }), effect: "act", ...overrides,
    });

    /** Calls a Band tool on the MCP server the adapter started the query with, as Claude Code would. */
    async function callBandTool(options: ClaudeSDKQueryParams["options"], name: string, args: Record<string, unknown> = {}): Promise<void> {
      const result = await callMcpTool(options, name, { room_id: ROOM_ID, ...args });
      expect(result.isError, `${name} failed`).toBeUndefined();
    }

    const assistantText = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
    const success = (text: string) => ({ type: "result", subtype: "success", result: text });
    const closing = (text: string) => [assistantText(text), success(text)] as never[];

    /** What Claude does in one contract turn, its tool calls landing through the MCP bridge. */
    async function* contractTurn(script: TurnScript, options: ClaudeSDKQueryParams["options"]): AsyncGenerator<never> {
      switch (script) {
        case "decline":
          await callBandTool(options, NO_REPLY_TOOL_NAME, NO_REPLY_ARGS);
          yield* closing(CLOSING_TEXT);
          return;
        case "toolReply":
          await callBandTool(options, SEND_MESSAGE_TOOL_NAME, TOOL_REPLY_ARGS);
          yield* closing(CLOSING_TEXT);
          return;
        case "act":
          await callBandTool(options, ACT_TOOL, ACT_ARGS);
          yield success("") as never;
          return;
        case "finalText":
          yield* closing(CLOSING_TEXT);
          return;
        case "nothing":
          yield success("") as never;
          return;
      }
    }

    describeTurnOutcomeContract([{
      adapter: "ClaudeSDKAdapter",
      turn: async (script, tools) => {
        const adapter = new ClaudeSDKAdapter({ queryFn: ({ options }) => contractTurn(script, options) });
        await adapter.onStarted("Parity Agent", "Parity test agent");
        await adapter.onEvent(turnInput(tools, SENDER));
      },
    }]);

    describeCustomToolEffect("ClaudeSDKAdapter (real MCP)", async (def, tools) => {
      const adapter = new ClaudeSDKAdapter({
        customTools: [def],
        queryFn: async function* ({ options }) {
          await callBandTool(options, def.name);
          yield success("") as never;
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await adapter.onEvent(turnInput(tools, SENDER));
    });

    it("strips routing before strict validation, and transforms business inputs once", async () => {
      const transform = vi.fn((text: string) => `${text}!`);
      const handler = vi.fn((args) => args);
      const adapter = new ClaudeSDKAdapter({
        customTools: [portable({ name: " write_marker ", schema: z.strictObject({
          payload: z.strictObject({ text: z.string().transform(transform) }), count: z.number().default(2),
        }), handler })],
        queryFn: async function* ({ options }) {
          expect(options?.allowedTools).toContain("mcp__band__write_marker");
          const result = await callMcpTool(options, "write_marker", { room_id: ` ${ROOM_ID} `, payload: { text: "hello" } });
          expect(result.isError).toBeUndefined();
          expect(result.content).toEqual([{ type: "text", text: '{"payload":{"text":"hello!"},"count":2}' }]);
          const invalid = await callMcpTool(options, "write_marker", { room_id: ROOM_ID, payload: { text: 5 } });
          expect(invalid.isError).toBe(true);
          yield success("") as never;
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await adapter.onEvent(turnInput(new FakeTools(), SENDER));
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith({ payload: { text: "hello!" }, count: 2 });
      expect(transform).toHaveBeenCalledOnce();
    });

    it.each([
      { name: "loose", schema: z.looseObject({ title: z.string().describe("Marker title") }), expectedExtra: "important", titleSchema: { type: "string", description: "Marker title" } },
      { name: "catchall", schema: z.object({ title: z.string() }).catchall(z.string().transform((text) => `${text}!`)), expectedExtra: "important!", titleSchema: { type: "string" } },
    ])("preserves undeclared business arguments for a $name schema", async ({ schema, expectedExtra, titleSchema }) => {
      const handler = vi.fn((args) => args);
      const args = { title: "hello", extra: "important" };
      const expected = { ...args, extra: expectedExtra };
      const adapter = new ClaudeSDKAdapter({
        customTools: [portable({ schema, handler })],
        queryFn: async function* ({ options }) {
          const client = await connectionTo(options?.mcpServers?.[MCP_SERVER_NAME] as McpSdkServerConfigWithInstance);
          const advertised = await client.listTools();
          expect(advertised.tools.find((entry) => entry.name === "write_marker")).toMatchObject({
            inputSchema: { properties: { title: titleSchema }, required: ["title", "room_id"] },
          });
          const result = await callMcpTool(options, "write_marker", { room_id: ROOM_ID, ...args });
          expect(result.isError).toBeUndefined();
          expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
          yield success("") as never;
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await adapter.onEvent(turnInput(new FakeTools(), SENDER));
      expect(handler).toHaveBeenCalledExactlyOnceWith(expected);
    });

    it.each([
      { name: "strict", schema: z.strictObject({ title: z.string() }), extra: "unexpected" },
      { name: "catchall", schema: z.object({ title: z.string() }).catchall(z.string()), extra: 42 },
    ])("rejects undeclared business arguments invalid for a $name schema", async ({ schema, extra }) => {
      const handler = vi.fn();
      const tools = new FakeTools();
      let result: McpResult | undefined;
      const adapter = new ClaudeSDKAdapter({
        customTools: [portable({ schema, handler })],
        queryFn: async function* ({ options }) {
          result = await callMcpTool(options, "write_marker", { room_id: ROOM_ID, title: "hello", extra });
          yield success("") as never;
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await expectTurnFailed(adapter.onEvent(turnInput(tools, SENDER)));
      expect(result?.isError).toBe(true);
      expect(result?.content).toEqual([expect.objectContaining({ text: expect.stringContaining("Invalid arguments for write_marker") })]);
      expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
      expect(handler).not.toHaveBeenCalled();
    });

    it.each([{ count: 1.5 }, { count: 2, payload: { extra: true } }])("enforces the original business schema after approximate MCP validation: %j", async (args) => {
      const handler = vi.fn();
      const tools = new FakeTools();
      let result: McpResult | undefined;
      const adapter = new ClaudeSDKAdapter({ customTools: [portable({
        schema: z.object({ count: z.number().int(), payload: z.strictObject({}).optional() }), handler,
      })], queryFn: async function* ({ options }) {
        result = await callMcpTool(options, "write_marker", { room_id: ROOM_ID, ...args });
        yield success("") as never;
      } });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await expectTurnFailed(adapter.onEvent(turnInput(tools, SENDER)));
      expect(result?.isError).toBe(true);
      expect(result?.content).toEqual([expect.objectContaining({ text: expect.stringContaining("Invalid arguments for write_marker") })]);
      expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
      expect(handler).not.toHaveBeenCalled();
    });

    it.each(["act", "reply", "decline", "observe"] as const)("handles portable %s and final text", async (effect) => {
      const tools = new FakeTools();
      const adapter = new ClaudeSDKAdapter({ customTools: [portable({ effect })], queryFn: async function* ({ options }) {
        await callBandTool(options, "write_marker");
        yield* closing(CLOSING_TEXT);
      } });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await adapter.onEvent(turnInput(tools, SENDER));
      expect(tools.messages).toEqual(effect === "reply" || effect === "decline" ? [] : [CLOSING_TEXT]);
    });

    it.each([{ ok: false }, "Error: refused"])("serializes failed output %j without credit or transport error", async (output) => {
      const tools = new FakeTools();
      let result: McpResult | undefined;
      const adapter = new ClaudeSDKAdapter({ customTools: [portable({ handler: () => output })], queryFn: async function* ({ options }) {
        result = await callMcpTool(options, "write_marker", { room_id: ROOM_ID });
        yield success("") as never;
      } });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await expectTurnFailed(adapter.onEvent(turnInput(tools, SENDER)));
      expect(result?.isError).toBeUndefined();
      expect(result?.content).toEqual([{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }]);
      expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
    });

    it("reports a thrown handler in the MCP error channel without credit, then recovers", async () => {
      let calls = 0;
      const tools = new FakeTools();
      const results: McpResult[] = [];
      const adapter = new ClaudeSDKAdapter({ customTools: [portable({ handler: async () => {
        if (++calls === 1) throw new Error("write rejected");
        return false;
      } })], queryFn: async function* ({ options }) {
        results.push(await callMcpTool(options, "write_marker", { room_id: ROOM_ID }));
        yield success("") as never;
      } });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await expectTurnFailed(adapter.onEvent(turnInput(tools, SENDER)));
      expect(results[0]).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("write rejected") }] });
      expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
      await adapter.onEvent(turnInput(new FakeTools(), SENDER));
      expect(results).toHaveLength(2);
      expect(results[1]?.isError).toBeUndefined();
      expect(results[1]?.content).toEqual([{ type: "text", text: "false" }]);
      expect(calls).toBe(2);
    });

    it("routes only to active rooms and preserves the room-id trust boundary", async () => {
      const bothStarted = createDeferred();
      const release = createDeferred();
      const handler = vi.fn(() => "done");
      let queries = 0;
      const optionsByRoom = new Map<string, ClaudeSDKQueryParams["options"]>();
      const adapter = new ClaudeSDKAdapter({ customTools: [portable({ handler })], queryFn: async function* (params) {
        optionsByRoom.set(params.prompt.includes('room_id="first"') ? "first" : "second", params.options);
        if (++queries === 2) bothStarted.resolve();
        await release.promise;
        yield success("") as never;
      } });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      const first = trackTurn(new FakeTools());
      const second = trackTurn(new FakeTools());
      const turns = [startMessage(adapter, first, "first"), startMessage(adapter, second, "second")];
      await bothStarted.promise;
      for (const room_id of [undefined, "", "  ", 4, "unknown"]) {
        const result = await callMcpTool(optionsByRoom.get("first"), "write_marker", room_id === undefined ? {} : { room_id });
        expect(result.isError).toBe(true);
      }
      expect(handler).not.toHaveBeenCalled();
      expect((await callMcpTool(optionsByRoom.get("second"), "write_marker", { room_id: "first" })).isError).toBe(true);
      await callMcpTool(optionsByRoom.get("first"), "write_marker", { room_id: " first " });
      expect(first.turn.verdict()).toBe("complete");
      expect(second.turn.verdict()).toBe("missing_reply");
      await callMcpTool(optionsByRoom.get("second"), "write_marker", { room_id: "second" });
      release.resolve();
      await Promise.all(turns);
      await expect(callMcpTool(optionsByRoom.get("first"), "write_marker", { room_id: "first" })).rejects.toThrow(TRANSPORT_CLOSED);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("keeps a pending handler's turn and lets an old finally leave the replacement binding intact", async () => {
      const handlerStarted = createDeferred();
      const releaseHandler = createDeferred();
      const replacementStarted = createDeferred();
      const releaseReplacement = createDeferred();
      let queries = 0;
      let options: ClaudeSDKQueryParams["options"];
      const adapter = new ClaudeSDKAdapter({
        customTools: [portable({ schema: z.object({ old: z.boolean() }), handler: async ({ old }) => {
          if (old) { handlerStarted.resolve(); await releaseHandler.promise; }
          return "done";
        } })],
        queryFn: async function* (params) {
          options = params.options;
          const old = ++queries === 1;
          if (!old) { replacementStarted.resolve(); await releaseReplacement.promise; }
          await callBandTool(params.options, "write_marker", { old });
          yield success("") as never;
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      const first = trackTurn(new FakeTools());
      const second = trackTurn(new FakeTools());
      const pending = startMessage(adapter, first);
      await handlerStarted.promise;
      await adapter.onCleanup(ROOM_ID);
      await expect(callMcpTool(options, "write_marker", { room_id: ROOM_ID, old: false })).rejects.toThrow(TRANSPORT_CLOSED);
      const replacement = startMessage(adapter, second);
      await replacementStarted.promise;
      releaseHandler.resolve();
      await pending;
      expect(second.turn.verdict()).toBe("missing_reply");
      releaseReplacement.resolve();
      await replacement;
      expect(first.turn.verdict()).toBe("complete");
      expect(second.turn.verdict()).toBe("complete");
      await expect(callMcpTool(options, "write_marker", { room_id: ROOM_ID, old: false })).rejects.toThrow(TRANSPORT_CLOSED);
    });

    it("does not reinstall a cleaned-up binding when query loading finishes", async () => {
      const loading = createDeferred();
      const releaseLoad = createDeferred();
      const handler = vi.fn();
      const queryFn = vi.fn(async function* () {
        yield success("") as never;
      });
      const adapter = new ClaudeSDKAdapter({ customTools: [portable({ handler })], queryFn });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      // Hold only the asynchronous loading boundary; the bridge and its calls remain real.
      const loader = adapter as unknown as { startQuery: (...args: unknown[]) => Promise<AsyncIterable<unknown>> };
      const original = loader.startQuery.bind(adapter);
      vi.spyOn(loader, "startQuery").mockImplementationOnce(async (...args) => {
        loading.resolve();
        await releaseLoad.promise;
        return original(...args);
      });
      const pending = startMessage(adapter, trackTurn(new FakeTools()));
      await loading.promise;
      await adapter.onCleanup(ROOM_ID);
      releaseLoad.resolve();
      await pending;
      expect(queryFn).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    const staleCallRefused = async (options: ClaudeSDKQueryParams["options"]) =>
      expect((await callMcpTool(options, "write_marker", { room_id: ROOM_ID })).isError).toBe(true);
    const staleCallDisconnected = async (options: ClaudeSDKQueryParams["options"]) =>
      await expect(callMcpTool(options, "write_marker", { room_id: ROOM_ID })).rejects.toThrow(TRANSPORT_CLOSED);
    const deliveryFailed = (turn: Promise<unknown>) => expect(turn).rejects.toBeInstanceOf(DeliveryFailedError);

    it.each([
      { exit: "query" as const, firstTurn: expectTurnFailed, staleCall: staleCallRefused },
      { exit: "stream" as const, firstTurn: expectTurnFailed, staleCall: staleCallDisconnected },
      { exit: "result" as const, firstTurn: expectTurnFailed, staleCall: staleCallDisconnected },
      { exit: "relay" as const, firstTurn: deliveryFailed, staleCall: staleCallDisconnected },
    ])("clears binding on $exit failure and runs the next turn", async ({ exit, firstTurn, staleCall }) => {
      let calls = 0;
      let options: ClaudeSDKQueryParams["options"];
      const adapter = new ClaudeSDKAdapter({ customTools: [portable()], queryFn: (params) => {
        options = params.options;
        const failing = ++calls === 1;
        if (failing && exit === "query") throw new Error("query failed");
        return (async function* () {
          await callBandTool(params.options, "write_marker");
          if (failing && exit === "stream") throw new Error("stream failed");
          if (failing && exit === "result") yield { type: "result", subtype: "error_max_turns", errors: ["turn cap"], is_error: true } as never;
          else yield success(failing && exit === "relay" ? "closing text" : "") as never;
        })();
      } });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      const failingTools = new FakeTools(exit === "relay" ? { failOn: ["sendMessage"] } : undefined);
      await firstTurn(adapter.onEvent(turnInput(failingTools, SENDER)));
      await staleCall(options);
      await adapter.onEvent(turnInput(new FakeTools(), SENDER));
      expect(calls).toBe(2);
      await expect(callMcpTool(options, "write_marker", { room_id: ROOM_ID })).rejects.toThrow(TRANSPORT_CLOSED);
    });

    it("preserves raw MCP registrations without giving their successful calls portable effect credit", async () => {
      const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "native result" }] }));
      const tools = new FakeTools();
      let result: McpResult | undefined;
      const adapter = new ClaudeSDKAdapter({
        customTools: [portable({ effect: "observe" })],
        additionalMcpTools: [{ name: "native", description: "native", inputSchema: { type: "object", properties: {}, required: [] }, execute }],
        queryFn: async function* ({ options }) {
          expect(options?.allowedTools).toEqual(expect.arrayContaining(["mcp__band__native", "mcp__band__write_marker"]));
          result = await callMcpTool(options, "native", { undeclared: "native input" });
          await callBandTool(options, "write_marker");
          yield success("") as never;
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      await expectTurnFailed(adapter.onEvent(turnInput(tools, SENDER)));
      expect(result?.content).toEqual([{ type: "text", text: "native result" }]);
      expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
      expect(execute).toHaveBeenCalledExactlyOnceWith({});
    });

    it.each([false, true])("checks portable collisions only against active memory tools (enabled=%s)", async (enableMemoryTools) => {
      const adapter = new ClaudeSDKAdapter({ enableMemoryTools, customTools: [portable({ name: "band_store_memory" })], queryFn: async function* ({ options }) {
        await callBandTool(options, "band_store_memory");
        yield success("") as never;
      } });
      if (enableMemoryTools) await expect(adapter.onStarted("Agent", "description")).rejects.toThrow(/conflicts/);
      else {
        await adapter.onStarted("Agent", "description");
        await adapter.onEvent(turnInput(new FakeTools(), SENDER));
      }
    });

    it("keeps preceding text off the room on a failed result after a tool reply, and still reports the failure", async () => {
      const { tools, posted } = recordingRoomTools();
      const adapter = new ClaudeSDKAdapter({
        queryFn: async function* ({ options }) {
          await callBandTool(options, SEND_MESSAGE_TOOL_NAME, { content: "pineapple", mentions: ["@user"] });
          yield* [assistantText("Done!"), { type: "result", subtype: "error_max_turns", summary: "hit the turn cap" }] as never[];
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");

      await expectTurnFailed(adapter.onEvent(roomTurn(tools)));

      expect(posted).toEqual(["pineapple"]);
    });

    it("records each of two concurrent same-room turns' replies on that turn", async () => {
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      let queries = 0;
      const adapter = new ClaudeSDKAdapter({
        // The first turn's reply is held until the second turn is queued, so it lands while both are in flight.
        queryFn: async function* ({ options }) {
          const isFirst = ++queries === 1;
          if (isFirst) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          await callBandTool(options, SEND_MESSAGE_TOOL_NAME, { content: isFirst ? "first reply" : "second reply", mentions: ["@user"] });
          yield* closing(CLOSING_TEXT);
        },
      });
      await adapter.onStarted("Parity Agent", "Parity test agent");
      const first = recordingRoomTools();
      const second = recordingRoomTools();

      const firstTurn = adapter.onEvent(roomTurn(first.tools));
      await firstStarted.promise;
      const secondTurn = adapter.onEvent(roomTurn(second.tools));
      releaseFirst.resolve();
      await Promise.all([firstTurn, secondTurn]);

      expect(first.posted).toEqual(["first reply"]);
      expect(second.posted).toEqual(["second reply"]);
    });
  });

  describeDeliveryContract([{
    path: "final assistant text",
    turn: async (tools) => {
      const queryFn: ClaudeSDKQuery = () =>
        streamFrom([
          {
            type: "assistant",
            session_id: "session-delivery",
            message: {
              content: [{ type: "text", text: "final answer" }],
            },
          } as never,
        ]) as never;

      const adapter = new ClaudeSDKAdapter({ queryFn });
      await adapter.onStarted("Parity Agent", "Parity test agent");

      await adapter.onMessage(
        makeMessage("hello", "room-delivery"),
        tools,
        new HistoryProvider([]),
        null,
        null,
        { isSessionBootstrap: false, roomId: "room-delivery" },
      );
    },
  }]);
});

describe("Claude portable configuration", () => {
  const def: CustomToolDef = { name: "portable", schema: z.object({}), handler: vi.fn(), effect: "act" };
  it.each([
    [{ ...def, name: " " }],
    [def, { ...def, name: " portable " }],
    [{ ...def, effect: "bad" } as unknown as CustomToolDef],
    [{ ...def, schema: z.object({ room_id: z.string() }) }],
  ])("rejects invalid definitions before execution", (...customTools) => {
    expect(() => new ClaudeSDKAdapter({ customTools })).toThrow();
    expect(def.handler).not.toHaveBeenCalled();
  });
  it("rejects portable tools with disabled MCP, but preserves empty/native-only options", () => {
    expect(() => new ClaudeSDKAdapter({ customTools: [def], enableMcpTools: false })).toThrow(/enableMcpTools/);
    expect(() => new ClaudeSDKAdapter({ customTools: [], enableMcpTools: false })).not.toThrow();
  });
  it.each(["band_send_message", "native"])("rejects portable collision with active %s", async (name) => {
    const queryFn = vi.fn();
    const adapter = new ClaudeSDKAdapter({ customTools: [{ ...def, name }], queryFn, additionalMcpTools: [{
      name: "native", description: "native tool", inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => ({ content: [] }),
    }] });
    await expect(adapter.onStarted("Agent", "description")).rejects.toThrow(/conflicts/);
    expect(queryFn).not.toHaveBeenCalled();
  });
});
