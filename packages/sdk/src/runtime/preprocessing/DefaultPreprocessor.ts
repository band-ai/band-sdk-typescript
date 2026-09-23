import type { Preprocessor, PreprocessorContext } from "../../contracts/protocols";
import { HistoryProvider, type AgentInput, type PlatformMessage } from "../types";
import type { PlatformEvent } from "../../platform/events";
import { isSelfEcho } from "@band-ai/band-sdk-core";

function toPlatformMessage(roomId: string, payload: {
  id: string;
  content: string;
  sender_id: string;
  sender_type: string;
  sender_name?: string | null;
  message_type: string;
  metadata?: Record<string, unknown> | null;
  inserted_at: string;
}): PlatformMessage {
    return {
      id: payload.id,
      roomId,
      content: payload.content,
      senderId: payload.sender_id,
      senderType: payload.sender_type,
      senderName: payload.sender_name ?? null,
      messageType: payload.message_type,
      metadata: payload.metadata ?? {},
      createdAt: new Date(payload.inserted_at),
    };
  }

export class DefaultPreprocessor implements Preprocessor<PlatformEvent> {
  public async process(
    context: PreprocessorContext,
    event: PlatformEvent,
    agentId: string,
  ): Promise<AgentInput | null> {
    if (event.type !== "message_created" || !event.roomId) {
      return null;
    }

    const message = toPlatformMessage(event.roomId, event.payload);

    if (isSelfEcho(message.senderId, message.senderType, agentId)) {
      return null;
    }

    if (context.hasMessage(message.id)) {
      return null;
    }

    const isSessionBootstrap = !context.isLlmInitialized;
    if (isSessionBootstrap) {
      context.markLlmInitialized();
    }

    context.recordMessage(message);

    // Drain system messages; fall back to legacy contactsMessage for backward compat
    const systemMessages = context.consumeSystemMessages();
    let contactsMessage: string | null;
    if (systemMessages.length > 0) {
      contactsMessage = systemMessages.join("\n");
    } else {
      contactsMessage = context.consumeContactsMessage();
    }

    const history = isSessionBootstrap
      ? await context.getHydratedHistory(message.id)
      : context.getRawHistory();

    return {
      message,
      tools: context.getTools(),
      history: new HistoryProvider(history),
      participantsMessage: context.consumeParticipantsMessage(),
      contactsMessage,
      isSessionBootstrap,
      roomId: context.roomId,
    };
  }
}
