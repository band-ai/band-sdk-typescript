import type { TurnEffect } from "@band-ai/band-sdk-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { RestFacade } from "../src/client/rest/RestFacade";
import type { AdapterToolsProtocol, FrameworkAdapterInput } from "../src/contracts/protocols";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import type { CustomToolDef } from "../src/runtime/tools/customTools";
import { HistoryProvider, type PlatformMessage } from "../src/runtime/types";
import { expectTurnFailed, FakeRestApi, FakeTools, failureEvents, makeMessage, MISSING_REPLY, reportedFailures } from "./testUtils";

/**
 * What the scripted model does in one contract turn:
 * - `decline`: calls `band_no_reply`, then closes with {@link CLOSING_TEXT}.
 * - `toolReply`: calls `band_send_message` with {@link TOOL_REPLY}, then closes with {@link CLOSING_TEXT}.
 * - `act`: calls an `act` tool (such as `band_add_participant`) and says nothing.
 * - `finalText`: only says {@link CLOSING_TEXT}.
 * - `nothing`: calls no tool and says nothing.
 */
export type TurnScript = "decline" | "toolReply" | "act" | "finalText" | "nothing";

export const CLOSING_TEXT = "All done here.";
export const TOOL_REPLY = "Here is the answer.";

/** The Band tool calls the scripts make, the same for every adapter's model. */
export const NO_REPLY_ARGS = { reason: "FYI only" };
export const TOOL_REPLY_ARGS = { content: TOOL_REPLY, mentions: ["@user"] };
export const ACT_TOOL = "band_add_participant";
export const ACT_ARGS = { name: "Helper" };

export interface TurnOutcomeCase {
  /** The adapter under test, as it reads in the test name. */
  adapter: string;
  /**
   * Runs one turn through the adapter's `onEvent` on `tools`, its model
   * scripted to `script`. Build the adapter inside: each row runs once.
   */
  turn: (script: TurnScript, tools: FakeTools) => Promise<void>;
}

/** The real Band tool schemas, for a fake whose model calls Band tools by name. */
export function bandToolSchemas(): Array<Record<string, unknown>> {
  return new AgentTools({ roomId: "room-1", rest: new RestFacade({ api: new FakeRestApi() }) }).getOpenAIToolSchemas();
}

/** The `onEvent` input of one turn on `tools`. */
export function turnInput(
  tools: AdapterToolsProtocol,
  message: PlatformMessage = makeMessage("Hello"),
  history: HistoryProvider = new HistoryProvider([]),
): FrameworkAdapterInput {
  return {
    message,
    tools,
    history,
    participantsMessage: null,
    contactsMessage: null,
    isSessionBootstrap: true,
    roomId: message.roomId,
  };
}

/**
 * Every judged adapter, and the test file that runs this contract on its
 * turn handling. A subclass that only configures its parent shares the
 * parent's file.
 */
export const TURN_OUTCOME_ADAPTERS: Readonly<Record<string, string>> = {
  ToolCallingAdapter: "tool-calling-adapter.test.ts",
  OpenAIAdapter: "tool-calling-adapter.test.ts",
  AnthropicAdapter: "tool-calling-adapter.test.ts",
  GeminiAdapter: "tool-calling-adapter.test.ts",
  VercelAISDKAdapter: "tool-calling-adapter.test.ts",
  LangGraphAdapter: "langgraph-adapter.test.ts",
  GoogleADKAdapter: "google-adk-adapter.test.ts",
  LettaAdapter: "letta-adapter.test.ts",
  ClaudeSDKAdapter: "claude-sdk-adapter.test.ts",
  CodexAdapter: "codex-adapter.test.ts",
  ACPClientAdapter: "acp-client-adapter.test.ts",
  CopilotACPAdapter: "acp-client-adapter.test.ts",
  KiroACPAdapter: "acp-client-adapter.test.ts",
  OmpACPAdapter: "acp-client-adapter.test.ts",
  CursorACPAdapter: "flows/cursor.flow.test.ts",
  OpencodeAdapter: "flows/opencode.flow.test.ts",
  GenericAdapter: "generic-adapter.test.ts",
};

/** Adapters whose turns owe no reply of their own, so they are never judged. */
export const TURN_OUTCOME_EXEMPT: ReadonlySet<string> = new Set([
  "A2AAdapter",
  "A2AGatewayAdapter",
  "BandACPServerAdapter",
  "ParlantAdapter",
]);

/**
 * The turn-outcome contract every judged adapter owes: band-sdk-core's rule
 * decides the turn, and its closing text is relayed only when the model
 * neither replied nor declined through a tool. `FakeTools.executeToolCall`
 * posts nothing, so a turn's `messages` are only what it relayed.
 */
export function describeTurnOutcomeContract(cases: TurnOutcomeCase[]): void {
  describe.each(cases)("turn outcome: $adapter", ({ turn }) => {
    it("completes a band_no_reply turn without a failure or a relay", async () => {
      const tools = new FakeTools();
      await turn("decline", tools);

      expect(failureEvents(tools)).toEqual([]);
      expect(tools.messages, "the closing text of a declined turn was relayed").toEqual([]);
    });

    it("completes a turn that replied by tool, without relaying its closing text", async () => {
      const tools = new FakeTools();
      await turn("toolReply", tools);

      expect(failureEvents(tools)).toEqual([]);
      expect(tools.messages, "the closing text was posted as a second reply").toEqual([]);
    });

    it("completes a turn that only acted", async () => {
      const tools = new FakeTools();
      await turn("act", tools);

      expect(failureEvents(tools)).toEqual([]);
    });

    it("relays a turn's final text once, and completes", async () => {
      const tools = new FakeTools();
      await turn("finalText", tools);

      expect(failureEvents(tools)).toEqual([]);
      expect(tools.messages).toEqual([CLOSING_TEXT]);
    });

    it("reports a turn that did nothing once, with core's text, and fails it", async () => {
      const tools = new FakeTools();
      await expectTurnFailed(turn("nothing", tools));

      expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
      expect(tools.messages).toEqual([]);
    });
  });
}

/** A custom tool that only has a side effect, declaring `effect` (or the default when omitted). */
function sideEffectTool(effect?: TurnEffect): CustomToolDef {
  return { name: "create_ticket", schema: z.object({}), handler: async () => ({ ok: true }), effect };
}

/**
 * Each adapter passes its turn to a custom tool's declared effect: `turn` runs
 * one turn on `tools` whose model only calls `tool`, with no arguments.
 */
export function describeCustomToolEffect(
  adapter: string,
  turn: (tool: CustomToolDef, tools: FakeTools) => Promise<void>,
): void {
  describe(`custom tool effect: ${adapter}`, () => {
    it("completes a turn whose only action is a custom tool declared `act`", async () => {
      const tools = new FakeTools();
      await turn(sideEffectTool("act"), tools);

      expect(reportedFailures(tools.events)).toEqual([]);
    });

    it("reports a turn whose only action is an undeclared custom tool, which only observes", async () => {
      const tools = new FakeTools();
      await expectTurnFailed(turn(sideEffectTool(), tools));

      expect(reportedFailures(tools.events)).toEqual([MISSING_REPLY]);
    });
  });
}
