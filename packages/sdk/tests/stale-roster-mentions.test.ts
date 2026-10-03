import { describe, expect, test } from "vitest";

import { GenericAdapter } from "../src/adapters/GenericAdapter";
import { BandLink } from "../src/platform/BandLink";
import { PlatformRuntime } from "../src/runtime/PlatformRuntime";
import { FakeRestApi, FakeTransport } from "./testUtils";

const AGENT_ID = "agent-1";
const ROOM_ID = "room-1";

// A type alias, not an interface, so it passes as an event payload record.
type Participant = { id: string; name: string; type: string; handle: string };

const jane: Participant = { id: "u-jane", name: "Jane", type: "User", handle: "jane" };
const bob: Participant = { id: "u-bob", name: "Bob", type: "User", handle: "bob" };
const carl: Participant = { id: "u-carl", name: "Carl", type: "User", handle: "carl" };

interface Turn {
  content: string;
  participantsMessage: string | null;
}

/**
 * The platform side of one room: who is really in it, the events the agent
 * receives, and the REST calls it makes. The agent replies to every message by
 * mentioning the handles the message names, as a model told "welcome @carl" would.
 */
class LiveRoom {
  public readonly turns: Turn[] = [];
  public readonly posted: Array<{ content: string; mentionIds: string[] }> = [];
  private readonly transport = new FakeTransport();
  private members: Participant[] = [];
  private heldFetch: { started: () => void; skipped: (error: Error) => void; released: Promise<void> } | null = null;
  private readonly turnDone = new Map<string, () => void>();
  private messageCount = 0;

  public readonly runtime = new PlatformRuntime({
    agentId: AGENT_ID,
    apiKey: "key",
    link: new BandLink({
      agentId: AGENT_ID,
      apiKey: "key",
      transport: this.transport,
      restApi: new FakeRestApi({
        listChatParticipants: async () => {
          const snapshot = [...this.members];
          const held = this.heldFetch;
          this.heldFetch = null;
          held?.started();
          await held?.released;
          return snapshot;
        },
        createChatMessage: async (_roomId, message) => {
          this.posted.push({ content: message.content, mentionIds: (message.mentions ?? []).map((m) => m.id) });
          return {};
        },
      }),
    }),
  });

  public async open(): Promise<void> {
    await this.runtime.start(
      new GenericAdapter(async ({ message, tools, participantsMessage }) => {
        this.turns.push({ content: message.content, participantsMessage });
        try {
          await tools.sendMessage("ack", message.content.match(/@\w+/g) ?? []);
        } finally {
          this.heldFetch?.skipped(new Error("the agent finished its turn without fetching participants"));
          this.heldFetch = null;
          this.turnDone.get(message.id)?.();
        }
      }),
    );
    const now = new Date().toISOString();
    await this.transport.emit(`agent_rooms:${AGENT_ID}`, "room_added", {
      id: ROOM_ID, status: "active", type: "group", title: "Room", task_id: null, inserted_at: now, updated_at: now,
    });
    // Admission joins the room's topics in sequence; let both settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  public async join(participant: Participant): Promise<void> {
    this.members.push(participant);
    await this.transport.emit(`room_participants:${ROOM_ID}`, "participant_added", participant);
  }

  /** In the room, but the agent never received the participant_added event. */
  public joinUnseen(participant: Participant): void {
    this.members.push(participant);
  }

  public async leave(participant: Participant): Promise<void> {
    this.members = this.members.filter((member) => member.id !== participant.id);
    await this.transport.emit(`room_participants:${ROOM_ID}`, "participant_removed", participant);
  }

  /** Resolves once the agent has finished its turn for this message. */
  public async say(sender: Participant, content: string): Promise<void> {
    this.messageCount += 1;
    const id = `m-${this.messageCount}`;
    const done = new Promise<void>((resolve) => this.turnDone.set(id, resolve));
    const now = new Date().toISOString();
    await this.transport.emit(`chat_room:${ROOM_ID}`, "message_created", {
      id, content, message_type: "text", sender_id: sender.id, sender_type: sender.type, sender_name: sender.name,
      inserted_at: now, updated_at: now,
    });
    await done;
  }

  /** Holds the agent's next participant fetch; `started` rejects if the turn ends without one. */
  public holdNextParticipantFetch(): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve, reject) => {
      this.heldFetch = { started: resolve, skipped: reject, released };
    });
    return { started, release };
  }
}

const it = test.extend<{ room: LiveRoom }>({
  room: async ({}, use) => {
    const room = new LiveRoom();
    await room.open();
    await use(room);
    await room.runtime.stop();
  },
});

describe("replying with mentions while the agent's view of the room is stale", () => {
  it("mentions a participant whose join the agent missed", async ({ room }) => {
    await room.join(jane);
    await room.say(jane, "hello @jane");
    room.joinUnseen(bob);

    await room.say(bob, "hi, I'm new @bob");

    expect(room.posted.at(-1)).toEqual({ content: "ack", mentionIds: [bob.id] });
  });

  it("keeps a departure that happens while it looks up a mention", async ({ room }) => {
    await room.join(jane);
    await room.join(bob);
    room.joinUnseen(carl);
    const fetch = room.holdNextParticipantFetch();

    const welcomed = room.say(jane, "welcome @carl");
    await fetch.started;
    await room.leave(bob);
    fetch.release();
    await welcomed;
    await room.say(jane, "anyone else here?");

    expect(room.posted.at(-2)).toEqual({ content: "ack", mentionIds: [carl.id] });
    expect(room.turns.at(-1)?.participantsMessage).not.toContain("@bob");
  });
});
