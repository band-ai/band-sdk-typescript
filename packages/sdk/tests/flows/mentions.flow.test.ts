/**
 * A mention in a Band room, through the real platform runtime into each kind
 * of adapter: the platform stores it as an `@[[id]]` token, and the model or
 * agent must be handed the participant's handle instead, both in the turn it
 * arrives and in the history a fresh session is handed.
 */
import { describe, expect, it } from "vitest";

import { CursorACPAdapter } from "../../src/adapters/cursor-acp";
import { GenericAdapter } from "../../src/adapters/GenericAdapter";
import { GoogleADKAdapter } from "../../src/adapters/google-adk";
import { ClaudeSDKAdapter } from "../../src/adapters/claude-sdk";
import { ToolCallingAdapter } from "../../src/adapters/tool-calling";
import type { MentionInput, ParticipantRecord } from "../../src/contracts/dtos";
import type { FrameworkAdapter } from "../../src/contracts/protocols";
import { CaptureToolCallingModel } from "../helpers/captureToolCallingModel";
import { createFakeGoogleAdkSdk } from "../helpers/fakeGoogleAdkSdk";
import { AGENT_HANDLE, AGENT_ID, BandPlatform, person, RecordingRestApi } from "./support/bandPlatform";
import { FakeCursorAgent } from "./support/fakeCursorAgent";
import { tmpRoot } from "../testUtils";

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
      const adapter = new CursorACPAdapter({ cwd: tmpRoot(), enableMcpTools: false, connectionFactory: agent.connectionFactory });
      return {
        adapter,
        handedOver: () => agent.receivedOf("session/prompt").flatMap((params) => (params as { prompt: Array<{ text?: string }> }).prompt.map((block) => block.text ?? "")),
      };
    },
  },
];

describe("Mentions in a Band room", () => {
  it.each(HARNESSES)("hand $name the participant's handle, not the platform's token", async ({ harness }) => {
    const rest = new RecordingRestApi([person(USER)]);
    const first = harness();
    {
      await using session = await BandPlatform.join(first.adapter, [person(USER)], { rest });
      await session.room.outcome(await session.room.say(USER, `@[[${AGENT_ID}]] ${EARLIER}`));
    }

    // A fresh agent on the same room is handed the room's history, which holds the first message.
    const restarted = harness();
    await using session = await BandPlatform.join(restarted.adapter, [person(USER)], { rest });
    await session.room.outcome(await session.room.say(USER, `@[[${AGENT_ID}]] ${CURRENT}`));

    const firstSessionHanded = first.handedOver().join("\n");
    expect(firstSessionHanded).toContain(`@${AGENT_HANDLE} ${EARLIER}`);
    expect(firstSessionHanded).not.toContain(CURRENT);
    expect(firstSessionHanded).not.toContain("@[[");


    const afterRestart = restarted.handedOver().join("\n");
    expect(afterRestart).toContain(`@${AGENT_HANDLE} ${EARLIER}`);
    expect(afterRestart).toContain(`@${AGENT_HANDLE} ${CURRENT}`);
    expect(afterRestart).not.toContain("@[[");
  });
});

const ADA: ParticipantRecord = { id: "user-ada", name: "Ada", type: "User", handle: "owner/ada" };
const REPLY = "on it";

describe("Mentions the agent sends", () => {
  it.each<{ name: string; mentions: MentionInput; posted: string[][] }>([
    { name: "one handle given twice, with and without @ and in another case, posts one mention", mentions: ["owner/ada", "@OWNER/Ada"], posted: [[ADA.id]] },
    { name: "an id plus the same participant's handle posts one", mentions: [ADA.id, "@owner/ada"], posted: [[ADA.id]] },
    { name: "two object-form entries for one participant post one", mentions: [{ id: ADA.id, handle: "owner/ada" }, { id: ADA.id }], posted: [[ADA.id]] },
    { name: "an unknown entry posts nothing", mentions: ["owner/ada", "@owner/nobody"], posted: [] },
  ])("$name", async ({ mentions, posted }) => {
    const replies = new GenericAdapter(async ({ tools }) => {
      await tools.sendMessage(REPLY, mentions);
    });
    await using session = await BandPlatform.join(replies, [ADA]);

    await session.room.outcome(await session.room.say(ADA.id, `@[[${AGENT_ID}]] can you help`));

    expect(session.room.messages.map((message) => message.mentions)).toEqual(posted);
  });
});
