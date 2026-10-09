/**
 * The fixtures every flow test of the plugin starts from: a Band platform whose
 * room holds the owner, a user and a peer agent, and a Claude Code session
 * connected to it.
 */
import { test } from "vitest";

import { agent, BandPlatform, person, type BandRoom, type PlatformParticipant } from "../../../../../packages/sdk/tests/flows/support/bandPlatform";
import { ClaudeCodeSession, linkTo } from "./claudeCode";

export const OWNER = "owner-1";
export const USER = "user-1";
export const PEER_AGENT = "agent-2";
export const PEER_HANDLE = "owner/claude2";
export const PEER: PlatformParticipant = { ...agent(PEER_AGENT, "Reviews pull requests"), handle: PEER_HANDLE };
export const QA_WEB: PlatformParticipant = { ...agent("agent-3", "QA for the web app"), name: "Web QA", handle: "owner/qa-web" };
export const QA_MOBILE: PlatformParticipant = { ...agent("agent-4", "QA for the mobile app"), name: "Mobile QA", handle: "owner/qa-mobile" };
export const PEOPLE: PlatformParticipant[] = [person(OWNER), person(USER), PEER, QA_WEB, QA_MOBILE];
export const ROOM = "room-1";

export interface Band {
  platform: BandPlatform;
  room: BandRoom;
}

/** A test with `band` (the platform and its room) and `session` (Claude Code connected to it). */
export const it = test.extend<{ band: Band; session: ClaudeCodeSession }>({
  band: async ({}, use) => {
    const platform = BandPlatform.host(PEOPLE, { ownerUuid: OWNER });
    await use({ platform, room: await platform.room(ROOM) });
  },
  session: async ({ band }, use) => {
    await using session = await ClaudeCodeSession.connect(linkTo(band.platform));
    await use(session);
  },
});
