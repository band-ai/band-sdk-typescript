/**
 * Two different frameworks collaborate in one room: a coordinator asks a
 * specialist for a secret only the specialist knows, then reports it back.
 * The secret is opaque, so it reaches the coordinator's report only through
 * the specialist's reply.
 */
import { expect } from "vitest";

import { assertReplied } from "../../toolkit/assertMessages";
import { observeRoom } from "../../toolkit/observeMessages";
import { withAdapters } from "../../toolkit/perAdapter";
import type { AdapterId } from "../../toolkit/registry";
import { Rooms } from "../../toolkit/rooms";
import { uniqueMarker } from "../samples/markers";

const secret = uniqueMarker("CODE");
const COLLAB_PROMPT =
  "You are one agent in a shared multi-agent room. Follow the user's instructions exactly. " +
  "When you ask another agent something, mention them in your message; when they answer, report back to whoever asked you.";
const COORDINATOR: AdapterId = "anthropic";
const SPECIALIST: AdapterId = "google-adk";
// Only the specialist is built knowing the secret.
const SPECIALIST_PROMPT = `${COLLAB_PROMPT} Your secret access code is ${secret}. Share it with any agent that asks for it.`;

withAdapters(
  [COORDINATOR, SPECIALIST],
  "behavior.multiAgentCollaboration",
  async ({ agents: [coordinator, specialist], room }) => {
    await Rooms.sendMention(
      room,
      coordinator!,
      `Ask @${specialist!.name} for their secret access code, then reply to me with the exact code they gave you.`,
    );
    const report = await observeRoom(room).untilReplyMatching(coordinator!, (message) => message.content.includes(secret));
    assertReplied(report);

    const answers = (await observeRoom(room).history("text")).filter((message) => message.senderId === specialist!.id);
    expect(
      answers.some((message) => message.content.includes(secret) && message.mentionIds.includes(coordinator!.id)),
      "the specialist answered the coordinator with the secret",
    ).toBe(true);
  },
  {
    prompt: COLLAB_PROMPT,
    build: (spec, options) => spec.build(spec.id === SPECIALIST ? { ...options, prompt: SPECIALIST_PROMPT } : options),
  },
);
