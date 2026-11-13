import { describe, expect, it } from "vitest";

import {
  predictStoredContent,
  sameFingerprint,
  sentFingerprint,
  storedFingerprint,
  type SentMention,
} from "../src/client/rest/messageDelivery";
import type { PlatformChatMessage } from "../src/client/rest/types";

const BOB = "b0b-id";
const ANN = "a11-id";

/**
 * What Band stores for a post, one row per branch of its mention rewrite. The
 * first six rows were checked against the live platform: each content was
 * posted and read back through `/context`.
 */
const REWRITES: Array<{ branch: string; content: string; mentions: SentMention[]; stored: string }> = [
  { branch: "handle", content: "probe handle @bob/agent done", mentions: [{ id: BOB, handle: "bob/agent" }], stored: `probe handle @[[${BOB}]] done` },
  { branch: "name", content: "probe name @Bob done", mentions: [{ id: BOB, name: "Bob" }], stored: `probe name @[[${BOB}]] done` },
  { branch: "prepend", content: "probe prepend", mentions: [{ id: BOB, handle: "bob/agent" }], stored: `@[[${BOB}]] probe prepend` },
  { branch: "prefix overlap", content: "probe @bob/agentxyz and @bob/agent", mentions: [{ id: BOB, handle: "bob/agent" }], stored: `probe @[[${BOB}]]xyz and @[[${BOB}]]` },
  { branch: "handle before name", content: "probe @bob/agent and @Bob", mentions: [{ id: BOB, handle: "bob/agent", name: "Bob" }], stored: `probe @[[${BOB}]] and @Bob` },
  { branch: "existing placeholder", content: `probe @[[${BOB}]] kept`, mentions: [{ id: BOB }], stored: `probe @[[${BOB}]] kept` },
  { branch: "reference without a token", content: "probe reference", mentions: [{ id: ANN, handle: "ann" }, { id: BOB, handle: "bob/agent", kind: "reference" }], stored: `@[[${ANN}]] probe reference` },
  { branch: "two prepends, last first", content: "hello", mentions: [{ id: ANN }, { id: BOB }], stored: `@[[${BOB}]] @[[${ANN}]] hello` },
];

function storedMessage(content: string, mentionIds: string[]): PlatformChatMessage {
  return {
    id: "m-1",
    content,
    sender_id: "agent",
    sender_type: "Agent",
    message_type: "text",
    metadata: { mentions: mentionIds.map((id) => ({ id, kind: "mention" })) },
    inserted_at: "2026-01-01T00:00:00.000000Z",
  };
}

describe("message delivery fingerprint", () => {
  it.each(REWRITES)("predicts Band's stored content: $branch", ({ content, mentions, stored }) => {
    expect(predictStoredContent(content, mentions)).toBe(stored);
  });

  it.each(REWRITES)("matches the post Band stored: $branch", ({ content, mentions, stored }) => {
    const message = storedMessage(stored, mentions.map(({ id }) => id.toUpperCase()).reverse());

    expect(sameFingerprint(sentFingerprint(content, mentions), storedFingerprint(message))).toBe(true);
  });

  it.each([
    { difference: "other text", stored: `@[[${BOB}]] other`, mentionIds: [BOB] },
    { difference: "other mentions", stored: `@[[${BOB}]] probe prepend`, mentionIds: [BOB, ANN] },
  ])("does not match a post with $difference", ({ stored, mentionIds }) => {
    const sent = sentFingerprint("probe prepend", [{ id: BOB, handle: "bob/agent" }]);

    expect(sameFingerprint(sent, storedFingerprint(storedMessage(stored, mentionIds)))).toBe(false);
  });
});
