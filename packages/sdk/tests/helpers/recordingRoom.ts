import type { RestApi } from "../../src/client/rest/types";
import type { AdapterToolsProtocol } from "../../src/contracts/protocols";
import { AgentTools } from "../../src/runtime/tools/AgentTools";
import { FakeRestApi, makeRoster } from "../testUtils";

const ROOM_ID = "room-1";
/** The sender of `makeMessage`, as the room's roster knows them. */
export const SENDER = { id: "user-1", handle: "@jane", name: "Jane", type: "User" } as const;

type PostedMessage = Parameters<RestApi["createChatMessage"]>[1];
type PostedEvent = Parameters<RestApi["createChatEvent"]>[1];

/**
 * A room the real `AgentTools` drive, with the platform replaced by a REST
 * fake that records what a turn posted: its messages and its events (tool
 * calls, results, failures).
 */
export function recordingRoom(): { tools: AdapterToolsProtocol; messages: PostedMessage[]; events: PostedEvent[] } {
  const messages: PostedMessage[] = [];
  const events: PostedEvent[] = [];
  const rest = new FakeRestApi({
    createChatMessage: async (_chatId, message) => {
      messages.push(message);
      return { id: `posted-${messages.length}` };
    },
    createChatEvent: async (_chatId, event) => {
      events.push(event);
      return { id: `event-${events.length}` };
    },
  });
  const tools = new AgentTools({ roomId: ROOM_ID, rest, roster: makeRoster([SENDER]) }).getAdapterTools();
  return { tools, messages, events };
}

/** The failure messages a turn reported, from its recorded events. */
export function failureMessages(events: readonly PostedEvent[]): string[] {
  return events.flatMap((event) => {
    const failure = (event.metadata as { failure?: { message?: unknown } } | undefined)?.failure;
    return typeof failure?.message === "string" ? [failure.message] : [];
  });
}
