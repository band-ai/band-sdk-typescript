import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildCustomMcpRegistrations } from "../src/mcp/customTools";
import { trackTurn } from "../src/core/turn";

import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
  successResult,
  errorResult,
  ROOM_ID_ARG,
  type McpToolRegistration,
} from "../src/mcp/registrations";
import { NO_REPLY_TOOL_NAME, ROOM_TOOL_NAMES, SEND_MESSAGE_TOOL_NAME } from "../src/contracts/toolSchemas";
import { FakeTools } from "./testUtils";

describe("MCP registrations", () => {
  describe("buildSingleContextRegistrations", () => {
    it("builds registrations from TOOL_MODELS without room_id", () => {
      const tools = new FakeTools();
      const registrations = buildSingleContextRegistrations(tools);

      expect(registrations.length).toBeGreaterThan(0);

      for (const reg of registrations) {
        expect(reg.name).toMatch(/^band_/);
        expect(reg.description).toBeTruthy();
        expect(reg.inputSchema.type).toBe("object");
        expect(reg.inputSchema.required).not.toContain("room_id");
        expect(reg.execute).toBeInstanceOf(Function);
      }
    });

    it("excludes memory tools by default", () => {
      const tools = new FakeTools();
      const registrations = buildSingleContextRegistrations(tools);
      const names = registrations.map((r) => r.name);

      expect(names).not.toContain("band_list_memories");
      expect(names).not.toContain("band_store_memory");
    });

    it("includes memory tools when enabled", () => {
      const tools = new FakeTools();
      const registrations = buildSingleContextRegistrations(tools, {
        enableMemoryTools: true,
      });
      const names = registrations.map((r) => r.name);

      expect(names).toContain("band_list_memories");
      expect(names).toContain("band_store_memory");
    });

    it("delegates execute to tools.executeToolCall", async () => {
      const tools = new FakeTools();
      tools.executeToolCall = vi.fn().mockResolvedValue({ ok: true });

      const registrations = buildSingleContextRegistrations(tools);
      const sendMessage = registrations.find((r) => r.name === "band_send_message");
      expect(sendMessage).toBeDefined();

      const result = await sendMessage!.execute({ content: "hello" });
      expect(tools.executeToolCall).toHaveBeenCalledWith("band_send_message", { content: "hello" });
      expect(result.content[0].text).toContain("ok");
      expect(result.isError).toBeUndefined();
    });

    it("returns error result on tool execution failure", async () => {
      const tools = new FakeTools();
      tools.executeToolCall = vi.fn().mockRejectedValue(new Error("boom"));

      const registrations = buildSingleContextRegistrations(tools);
      const sendMessage = registrations.find((r) => r.name === "band_send_message")!;

      const result = await sendMessage.execute({ content: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("boom");
    });
  });

  describe("buildRoomScopedRegistrations", () => {
    it("injects room_id into input schema", () => {
      const resolver = vi.fn().mockReturnValue(new FakeTools());
      const registrations = buildRoomScopedRegistrations(resolver);

      for (const reg of registrations) {
        expect(reg.inputSchema.required).toContain("room_id");
        expect(reg.inputSchema.properties).toHaveProperty("room_id");
      }
    });

    it("resolves tools by room_id and strips it from args", async () => {
      const tools = new FakeTools();
      tools.executeToolCall = vi.fn().mockResolvedValue({ ok: true });
      const resolver = vi.fn().mockReturnValue(tools);

      const registrations = buildRoomScopedRegistrations(resolver);
      const sendMessage = registrations.find((r) => r.name === "band_send_message")!;

      await sendMessage.execute({ room_id: "room-1", content: "hello" });

      expect(resolver).toHaveBeenCalledWith("room-1");
      expect(tools.executeToolCall).toHaveBeenCalledWith("band_send_message", { content: "hello" });
    });

    it("returns error when room_id is missing", async () => {
      const resolver = vi.fn();
      const registrations = buildRoomScopedRegistrations(resolver);
      const sendMessage = registrations.find((r) => r.name === "band_send_message")!;

      const result = await sendMessage.execute({ content: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("room_id");
    });

    it("returns error when room tools not found", async () => {
      const resolver = vi.fn().mockReturnValue(undefined);
      const registrations = buildRoomScopedRegistrations(resolver);
      const sendMessage = registrations.find((r) => r.name === "band_send_message")!;

      const result = await sendMessage.execute({ room_id: "unknown", content: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("unknown");
    });

    it("with roomlessTools, takes room_id on room tools only, and runs the rest on roomlessTools", async () => {
      const roomTools = new FakeTools();
      const roomlessTools = new FakeTools();
      roomTools.executeToolCall = vi.fn().mockResolvedValue({ ok: true });
      roomlessTools.executeToolCall = vi.fn().mockResolvedValue({ id: "room-new" });
      const resolver = vi.fn().mockReturnValue(roomTools);

      const registrations = buildRoomScopedRegistrations(resolver, { roomlessTools, enableMemoryTools: true, enableContactTools: true });
      const takesRoom = registrations.filter((reg) => ROOM_ID_ARG in reg.inputSchema.properties).map((reg) => reg.name);
      expect(new Set(takesRoom)).toEqual(ROOM_TOOL_NAMES);
      for (const reg of registrations.filter((reg) => ROOM_TOOL_NAMES.has(reg.name))) {
        expect(reg.inputSchema.required).toContain(ROOM_ID_ARG);
      }

      const byName = (name: string) => registrations.find((reg) => reg.name === name)!;
      expect((await byName("band_create_chatroom").execute({})).content[0].text).toBe(JSON.stringify({ id: "room-new" }));
      await byName(NO_REPLY_TOOL_NAME).execute({});
      expect(roomlessTools.executeToolCall).toHaveBeenCalledWith("band_create_chatroom", {});
      expect(roomlessTools.executeToolCall).toHaveBeenCalledWith(NO_REPLY_TOOL_NAME, {});

      await byName(SEND_MESSAGE_TOOL_NAME).execute({ [ROOM_ID_ARG]: "room-1", content: "hello" });
      expect(resolver).toHaveBeenCalledWith("room-1");
      expect(roomTools.executeToolCall).toHaveBeenCalledWith(SEND_MESSAGE_TOOL_NAME, { content: "hello" });
      expect(roomlessTools.executeToolCall).toHaveBeenCalledTimes(2);
    });
  });

  describe("additionalTools", () => {
    function makeExtraTool(name = "my_custom_tool"): McpToolRegistration {
      return {
        name,
        description: "A custom tool",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        execute: async (args) => successResult(`echo: ${args.query}`),
      };
    }

    it("appends additional tools to single-context registrations", () => {
      const tools = new FakeTools();
      const extra = makeExtraTool();
      const registrations = buildSingleContextRegistrations(tools, {
        additionalTools: [extra],
      });
      const names = registrations.map((r) => r.name);

      expect(names).toContain("my_custom_tool");
      expect(names).toContain("band_send_message");
    });

    it("appends additional tools to room-scoped registrations", () => {
      const resolver = vi.fn().mockReturnValue(new FakeTools());
      const extra = makeExtraTool();
      const registrations = buildRoomScopedRegistrations(resolver, {
        additionalTools: [extra],
      });
      const names = registrations.map((r) => r.name);

      expect(names).toContain("my_custom_tool");
      expect(names).toContain("band_send_message");
    });

    it("additional tool execute is called directly", async () => {
      const tools = new FakeTools();
      const extra = makeExtraTool();
      const registrations = buildSingleContextRegistrations(tools, {
        additionalTools: [extra],
      });
      const custom = registrations.find((r) => r.name === "my_custom_tool")!;

      const result = await custom.execute({ query: "hello" });
      expect(result.content[0].text).toBe("echo: hello");
      expect(result.isError).toBeUndefined();
    });

    it("does not inject room_id into additional tools for room-scoped registrations", () => {
      const resolver = vi.fn().mockReturnValue(new FakeTools());
      const extra = makeExtraTool();
      const registrations = buildRoomScopedRegistrations(resolver, {
        additionalTools: [extra],
      });
      const custom = registrations.find((r) => r.name === "my_custom_tool")!;

      expect(custom.inputSchema.required).not.toContain("room_id");
    });
  });

  describe("result helpers", () => {
    it("successResult serializes objects as JSON", () => {
      const result = successResult({ foo: "bar" });
      expect(result.content[0].text).toBe('{"foo":"bar"}');
      expect(result.isError).toBeUndefined();
    });

    it("successResult passes strings through", () => {
      const result = successResult("hello");
      expect(result.content[0].text).toBe("hello");
    });

    it("errorResult sets isError flag", () => {
      const result = errorResult("something went wrong");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("something went wrong");
    });
  });
});

describe("shared portable MCP registrations", () => {
  it.each([undefined, "", "  ", 4, "unknown"])("refuses routing context %j without running the business handler", async (room_id) => {
    const tools = trackTurn(new FakeTools());
    const handler = vi.fn();
    const [registration] = buildCustomMcpRegistrations([{ name: "portable", schema: z.object({}), handler, effect: "act" }], (id) => id === "active" ? tools : undefined);
    const result = await registration!.execute({ room_id });
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(tools.turn.verdict()).toBe("missing_reply");
  });

  it("retains OpenCode's registration-time validation behavior", () => {
    const def = { name: "portable", schema: z.object({}), handler: () => "done" };
    expect(buildCustomMcpRegistrations([def, def], () => undefined)).toHaveLength(2);
    expect(() => buildCustomMcpRegistrations([{ ...def, effect: "bad" } as never], () => undefined)).not.toThrow();
    expect(() => buildCustomMcpRegistrations([{ ...def, schema: z.object({ room_id: z.string() }) }], () => undefined)).toThrow(/routing/);
  });
});
