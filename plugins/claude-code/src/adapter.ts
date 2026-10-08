import { deliverReply, type FrameworkAdapter, type FrameworkAdapterInput } from "@band-ai/sdk/core";
import { commandWords } from "@band-ai/sdk/runtime";

import { neutralizeChannelTags } from "./channelTag";

export const COMMAND_REFUSAL = "Only this agent's owner can send it slash commands.";

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

/** Pushes each delivered Band message into the Claude Code session. */
export class ChannelAdapter implements FrameworkAdapter {
  public constructor(private readonly options: ChannelAdapterOptions) {}

  public async onStarted(): Promise<void> {}

  public async onEvent({ message, tools }: FrameworkAdapterInput): Promise<void> {
    if (message.messageType !== TEXT_MESSAGE_TYPE) {
      return;
    }

    const isOwner = message.senderId === this.options.ownerUuid;
    // Claude Code never runs channel input as a command, but Claude can still act on one, e.g. by invoking a skill.
    if (!isOwner && isSlashCommand(message.content)) {
      await deliverReply(tools, COMMAND_REFUSAL, [message.senderId]);
      return;
    }

    await this.options.push({ content: neutralizeChannelTags(message.content), meta: channelMeta(message, isOwner) });
  }

  public async onCleanup(): Promise<void> {}
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
