import { describe, expect, it, vi } from "vitest";

import {
  buildRoomScopedRegistrations,
  buildSingleContextRegistrations,
  successResult,
  errorResult,
  type McpToolRegistration,
} from "../src/mcp/registrations";
import {
  createBandMcpBackend,
  createThenvoiMcpBackend,
  getBandSdkMcpServerConfig,
  getThenvoiSdkMcpServerConfig,
} from "../src/mcp";
import { FakeTools } from "./testUtils";

describe("MCP registrations", () => {
  it("exports legacy MCP backend aliases from the public barrel", () => {
    expect(createThenvoiMcpBackend).toBe(createBandMcpBackend);
    expect(getThenvoiSdkMcpServerConfig).toBe(getBandSdkMcpServerConfig);
  });

  describe("buildSingleContextRegistrations", () => {
    it("builds registrations from TOOL_MODELS without room_id", () => {
      const tools = new FakeTools();
      const registrations = buildSingleContextRegistrations(tools);

      const canonicalRegistrations = registrations.filter((reg) => reg.name.startsWith("band_"));
      expect(canonicalRegistrations.length).toBeGreaterThan(0);

      for (const reg of canonicalRegistrations) {
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

    it("registers legacy Thenvoi tool aliases", async () => {
      const tools = new FakeTools();
      tools.executeToolCall = vi.fn().mockResolvedValue({ ok: true });

      const registrations = buildSingleContextRegistrations(tools);
      const sendMessage = registrations.find((r) => r.name === "thenvoi_send_message");
      expect(sendMessage).toBeDefined();

      await sendMessage!.execute({ content: "hello", mentions: ["@jane"] });
      expect(tools.executeToolCall).toHaveBeenCalledWith("band_send_message", {
        content: "hello",
        mentions: ["@jane"],
      });
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
