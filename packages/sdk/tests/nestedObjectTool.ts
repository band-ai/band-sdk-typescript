import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";

import { successResult, type McpToolRegistration } from "../src/mcp/registrations";

const TOOL_NAME = "file_ticket";

const TICKET_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    labels: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
  required: ["title"],
};

/** An additional MCP tool whose argument is an object with its own properties, recording each call that reaches it. */
export class NestedObjectTool {
  public readonly calls: Record<string, unknown>[] = [];

  public readonly registration: McpToolRegistration = {
    name: TOOL_NAME,
    description: "File a ticket.",
    inputSchema: { type: "object", properties: { ticket: TICKET_SCHEMA }, required: ["ticket"] },
    execute: async (args) => {
      this.calls.push(args);
      return successResult("filed");
    },
  };
}

/** The nested-object contract every MCP backend must keep: listed, validated, and loose. */
export function describeNestedObjectTool(connect: (tool: NestedObjectTool) => Promise<Client>): void {
  describe("an additional tool with a nested object argument", () => {
    async function withClient(check: (client: Client, tool: NestedObjectTool) => Promise<void>): Promise<void> {
      const tool = new NestedObjectTool();
      const client = await connect(tool);
      try {
        await check(client, tool);
      } finally {
        await client.close();
      }
    }

    it("lists the object's own properties", () => withClient(async (client) => {
      const { tools } = await client.listTools();
      const listed = tools.find((entry) => entry.name === TOOL_NAME);
      expect(listed?.inputSchema.properties?.ticket).toMatchObject(TICKET_SCHEMA);
    }));

    it("rejects a call missing a nested required field", () => withClient(async (client, tool) => {
      const result = await client.callTool({ name: TOOL_NAME, arguments: { ticket: { labels: [] } } });
      expect(result.isError).toBe(true);
      expect(tool.calls).toEqual([]);
    }));

    it("passes undeclared nested keys through unchanged", () => withClient(async (client, tool) => {
      const ticket = { title: "Broken", labels: [{ name: "bug", color: "red" }], extra: { depth: 1 } };
      const result = await client.callTool({ name: TOOL_NAME, arguments: { ticket } });
      expect(result.isError).toBeUndefined();
      expect(tool.calls).toEqual([{ ticket }]);
    }));
  });
}
