import { deliverReply, type AdapterToolsProtocol, type FrameworkAdapter, type FrameworkAdapterInput } from "@band-ai/sdk/core";
import { commandWords } from "@band-ai/sdk/runtime";

export const COMMAND_REFUSAL = "Only this agent's owner can run slash commands.";

/** The `sender_role` a push carries; the instructions name the same values. */
export const SENDER_ROLE = { owner: "owner", participant: "participant" } as const;

const TEXT_MESSAGE_TYPE = "text";
const COMMAND_PREFIX = "/";

/** A channel event; Claude Code drops meta keys that aren't letters, digits and underscores. */
export type ChannelPush = {
  readonly content: string;
  readonly meta: Record<string, string>;
};

export interface ChannelAdapterOptions {
  /** The agent's owner; with none, every slash command is refused. */
  readonly ownerUuid?: string | null;
  readonly push: (push: ChannelPush) => Promise<void>;
}

/** Pushes each delivered Band message into the Claude Code session, and keeps each room's tools for Claude's replies. */
export class ChannelAdapter implements FrameworkAdapter {
  private readonly roomTools = new Map<string, AdapterToolsProtocol>();

  public constructor(private readonly options: ChannelAdapterOptions) {}

  public async onStarted(): Promise<void> {}

  public async onEvent({ roomId, message, tools }: FrameworkAdapterInput): Promise<void> {
    this.roomTools.set(roomId, tools);
    if (message.messageType !== TEXT_MESSAGE_TYPE) {
      return;
    }

    const isOwner = message.senderId === this.options.ownerUuid;
    if (!isOwner && isSlashCommand(message.content)) {
      await deliverReply(tools, COMMAND_REFUSAL, [message.senderId]);
      return;
    }

    await this.options.push({ content: message.content, meta: channelMeta(message, isOwner) });
  }

  public async onCleanup(roomId: string): Promise<void> {
    this.roomTools.delete(roomId);
  }

  /** Only rooms a message arrived from; any other room has no tools. */
  public toolsFor(roomId: string): AdapterToolsProtocol | undefined {
    return this.roomTools.get(roomId);
  }
}

function isSlashCommand(content: string): boolean {
  return commandWords(content)[0]?.startsWith(COMMAND_PREFIX) ?? false;
}

function channelMeta(message: FrameworkAdapterInput["message"], isOwner: boolean): Record<string, string> {
  return {
    room_id: message.roomId,
    message_id: message.id,
    sender_id: message.senderId,
    ...(message.senderName ? { sender_name: message.senderName } : {}),
    sender_role: isOwner ? SENDER_ROLE.owner : SENDER_ROLE.participant,
    sender_type: message.senderType,
  };
}
