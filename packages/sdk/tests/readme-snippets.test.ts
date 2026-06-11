import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { Agent } from "../src/agent/Agent";
import { HistoryProvider } from "../src/runtime/types";
import type { PlatformMessage } from "../src/runtime/types";
import { FakeAgentTools } from "../src/testing";
import {
  SDK_SUBPATH_ENTRIES,
  compileUnits,
  extractSnippets,
  formatSnippetDiagnostics,
  tsCompileUnits,
} from "./readmeSnippetHarness";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TESTS_DIR, "..");
const README_PATH = path.resolve(PACKAGE_ROOT, "../../README.md");

const readme = fs.readFileSync(README_PATH, "utf8");
const snippets = extractSnippets(readme);
const units = tsCompileUnits(snippets);
const results = compileUnits(units, PACKAGE_ROOT);

describe("README.md snippet extraction", () => {
  it("finds a sane number of TypeScript snippets", () => {
    // Catches a broken extraction regex or a gutted README.
    expect(units.length).toBeGreaterThanOrEqual(10);
  });

  it("covers every package.json export subpath in the snippet compiler", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    const fromExports = Object.keys(pkg.exports).map((key) =>
      key === "." ? "@thenvoi/sdk" : `@thenvoi/sdk/${key.slice(2)}`,
    );
    expect(Object.keys(SDK_SUBPATH_ENTRIES).sort()).toEqual(fromExports.sort());
  });

  it("maps every subpath to an existing source entry", () => {
    for (const entry of Object.values(SDK_SUBPATH_ENTRIES)) {
      expect(fs.existsSync(path.join(PACKAGE_ROOT, entry)), entry).toBe(true);
    }
  });
});

describe("README.md snippets compile against the SDK", () => {
  it.each(results.map((result) => [`README.md:${result.unit.fenceLine}`, result] as const))(
    "%s",
    (_label, result) => {
      expect(formatSnippetDiagnostics(result)).toBe("");
    },
  );
});

describe("README quickstart runtime smoke", () => {
  const incoming: PlatformMessage = {
    id: "msg-1",
    roomId: "room-1",
    content: "hello",
    senderId: "user-1",
    senderType: "user",
    senderName: "Pat",
    messageType: "text",
    metadata: {},
    createdAt: new Date(),
  };

  it("GenericAdapter handler replies through platform tools", async () => {
    const tools = new FakeAgentTools();
    const adapter = new GenericAdapter(async ({ message, tools: agentTools }) => {
      await agentTools.sendMessage(`Echo: ${message.content}`);
    });

    await adapter.onMessage(incoming, tools, new HistoryProvider([]), null, null, {
      isSessionBootstrap: false,
      roomId: incoming.roomId,
    });

    expect(tools.messagesSent).toEqual([{ content: "Echo: hello", mentions: undefined }]);
  });

  it("Agent.create wires adapter and config", () => {
    const agent = Agent.create({
      adapter: new GenericAdapter(async () => undefined),
      config: { agentId: "agent-id", apiKey: "api-key" },
    });

    expect(agent.isRunning).toBe(false);
    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stop).toBe("function");
  });
});
