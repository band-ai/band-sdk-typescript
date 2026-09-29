/**
 * A mention in a Band room, through the real platform runtime into each kind
 * of adapter: the platform stores it as an `@[[id]]` token, and the model or
 * agent must be handed the participant's handle instead, both in the turn it
 * arrives and in the history a fresh session is handed.
 */
import { describe, expect, it } from "vitest";

import { CursorACPAdapter } from "../../src/adapters/cursor-acp";
import { GoogleADKAdapter } from "../../src/adapters/google-adk";
import { ClaudeSDKAdapter } from "../../src/adapters/claude-sdk";
import { ToolCallingAdapter } from "../../src/adapters/tool-calling";
import type { FrameworkAdapter } from "../../src/contracts/protocols";
import { CaptureToolCallingModel } from "../helpers/captureToolCallingModel";
import { createFakeGoogleAdkSdk } from "../helpers/fakeGoogleAdkSdk";
import { AGENT_HANDLE, AGENT_ID, BandPlatform, person } from "./support/bandPlatform";
import { FakeCursorAgent } from "./support/fakeCursorAgent";

const USER = "user-1";
const EARLIER = "what do you remember about me";
const CURRENT = "please remember that I like tea";

/** An adapter under test, and everything its model or agent was handed. */
interface Harness {
  adapter: FrameworkAdapter;
  handedOver(): string[];
}

const HARNESSES: Array<{ name: string; harness: () => Harness }> = [
  {
    name: "tool-calling",
    harness: () => {
      const model = new CaptureToolCallingModel();
      return {
        adapter: new ToolCallingAdapter({ model, toolFormat: "openai" }),
        handedOver: () => model.requests.flatMap((request) => request.messages.flatMap((message) => (typeof message.content === "string" ? [message.content] : []))),
      };
    },
  },
  {
    name: "google-adk",
    harness: () => {
      const prompts: string[] = [];
      const sdkFactory = createFakeGoogleAdkSdk(async function* (_agent, request) {
        prompts.push(request.newMessage.parts[0]?.text ?? "");
        yield { final: true, text: "ok" };
      });
      return { adapter: new GoogleADKAdapter({ sdkFactory }), handedOver: () => prompts };
    },
  },
  {
    name: "claude-sdk",
    harness: () => {
      const prompts: string[] = [];
      const adapter = new ClaudeSDKAdapter({
        enableMcpTools: false,
        queryFn: ({ prompt }) => {
          prompts.push(String(prompt));
          return (async function* () {
            yield { type: "result", subtype: "success", result: "ok", session_id: "session-1" } as never;
          })();
        },
      });
      return { adapter, handedOver: () => prompts };
    },
  },
  {
    name: "acp",
    harness: () => {
      const agent = new FakeCursorAgent();
      const adapter = new CursorACPAdapter({ enableMcpTools: false, connectionFactory: agent.connectionFactory });
      return {
        adapter,
        handedOver: () => agent.receivedOf("session/prompt").flatMap((params) => (params as { prompt: Array<{ text?: string }> }).prompt.map((block) => block.text ?? "")),
      };
    },
  },
];

describe("Mentions in a Band room", () => {
  it.each(HARNESSES)("hand $name the participant's handle, not the platform's token", async ({ harness }) => {
    const first = harness();
    const rest = await (async () => {
      await using session = await BandPlatform.join(first.adapter, [person(USER)]);
      await session.room.outcome(await session.room.say(USER, `@[[${AGENT_ID}]] ${EARLIER}`));
      return session.platform.rest;
    })();

    // A fresh agent on the same room is handed the room's history, which holds the first message.
    const restarted = harness();
    await using session = await BandPlatform.join(restarted.adapter, [person(USER)], { rest });
    await session.room.outcome(await session.room.say(USER, `@[[${AGENT_ID}]] ${CURRENT}`));

    const currentTurn = first.handedOver().join("\n");
    expect(currentTurn).toContain(`@${AGENT_HANDLE} ${EARLIER}`);
    expect(currentTurn).not.toContain("@[[");

    const afterRestart = restarted.handedOver().join("\n");
    expect(afterRestart).toContain(`@${AGENT_HANDLE} ${EARLIER}`);
    expect(afterRestart).toContain(`@${AGENT_HANDLE} ${CURRENT}`);
    expect(afterRestart).not.toContain("@[[");
  });
});
