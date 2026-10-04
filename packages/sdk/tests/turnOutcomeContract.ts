import { missingReplyMessage } from "@band-ai/band-sdk-core";
import { describe, expect, it } from "vitest";

import { RestFacade } from "../src/client/rest/RestFacade";
import type { FrameworkAdapterInput } from "../src/contracts/protocols";
import { ProviderTurnFailedError } from "../src/core/providerFailure";
import { TURN_FAILURE_PROVIDER } from "../src/core/turn";
import { AgentTools } from "../src/runtime/tools/AgentTools";
import { HistoryProvider, type PlatformMessage } from "../src/runtime/types";
import { FakeRestApi, FakeTools, failureEvents, makeMessage } from "./testUtils";

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
  tools: FakeTools,
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

/** The relays a turn posted: every message, since the scripted tool calls post nothing themselves. */
function relayed(tools: FakeTools): readonly string[] {
  return tools.messages;
}

/**
 * The turn-outcome contract every judged adapter owes: band-sdk-core's rule
 * decides the turn, and its closing text is relayed only when the model
 * neither replied nor declined through a tool.
 */
export function describeTurnOutcomeContract(cases: TurnOutcomeCase[]): void {
  describe.each(cases)("turn outcome: $adapter", ({ turn }) => {
    it("completes a band_no_reply turn without a failure or a relay", async () => {
      const tools = new FakeTools();
      await turn("decline", tools);

      expect(failureEvents(tools)).toEqual([]);
      expect(relayed(tools), "the closing text of a declined turn was relayed").toEqual([]);
    });

    it("completes a turn that replied by tool, without relaying its closing text", async () => {
      const tools = new FakeTools();
      await turn("toolReply", tools);

      expect(failureEvents(tools)).toEqual([]);
      expect(relayed(tools), "the closing text was posted as a second reply").toEqual([]);
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
      expect(relayed(tools)).toEqual([CLOSING_TEXT]);
    });

    it("reports a turn that did nothing once, with core's text, and fails it", async () => {
      const tools = new FakeTools();
      await expect(turn("nothing", tools)).rejects.toBeInstanceOf(ProviderTurnFailedError);

      const failures = failureEvents(tools);
      expect(failures.map((event) => event.content)).toEqual([missingReplyMessage()]);
      expect(failures[0]?.metadata).toMatchObject({ failure: { provider: TURN_FAILURE_PROVIDER } });
      expect(relayed(tools)).toEqual([]);
    });
  });
}
