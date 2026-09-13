import type { ParticipantFields } from "@band-ai/band-sdk-core";
import type { ChatParticipant } from "../client/rest/types";
import type { MetadataMap, ParticipantRecord, ToolModelMessage } from "../contracts/dtos";
import { ensureHandlePrefix } from "./types";

function isMetadataMap(value: unknown): value is MetadataMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// `metadata.mentions` entries are validated against payloadSchemas.ts's
// mentionSchema, where `handle`, `name` and `username` are all independently
// nullish — any one of them can be the only field present on a given mention.
export function mentionSubjectsFromMetadata(metadata: MetadataMap | undefined): Array<Record<string, unknown>> {
  const mentions = metadata?.mentions;
  if (!Array.isArray(mentions)) {
    return [];
  }

  const subjects: Array<Record<string, unknown>> = [];
  for (const mention of mentions) {
    if (!isMetadataMap(mention) || typeof mention.id !== "string") {
      continue;
    }

    // `handle` first, then `username`: both are single-token identifiers, so
    // they read as a mention. A display name is the last resort — it can
    // contain spaces, which makes a poorer `@` token, but still beats a bare
    // id. A non-empty check, not just presence, matters here: `ensureHandlePrefix`
    // turns an empty-string handle into `null`, so replaceUuidMentions would
    // otherwise delete the mention outright instead of leaving it unresolved.
    const label = [mention.handle, mention.username, mention.name].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (label === undefined) {
      continue;
    }

    subjects.push({ id: mention.id, handle: label });
  }

  return subjects;
}

export function replaceUuidMentions(
  content: string,
  participants: Array<Record<string, unknown>>,
): string {
  if (!content || participants.length === 0) {
    return content;
  }

  let next = content;
  for (const participant of participants) {
    const participantId = participant.id;
    const handle = participant.handle;
    if (typeof participantId === "string" && typeof handle === "string") {
      next = next.replaceAll(`@[[${participantId}]]`, ensureHandlePrefix(handle) ?? "");
    }
  }

  return next;
}

export function formatMessageForLlm(
  message: Record<string, unknown>,
  participants?: Array<Record<string, unknown>>,
): ToolModelMessage {
  const senderType = String(message.sender_type ?? "");
  const senderName = String(message.sender_name ?? message.name ?? senderType);
  const content = participants
    ? replaceUuidMentions(String(message.content ?? ""), participants)
    : String(message.content ?? "");

  return {
    role: senderType === "Agent" ? "assistant" : "user",
    content,
    sender_name: senderName,
    sender_type: senderType,
    message_type: String(message.message_type ?? "text"),
    metadata: isMetadataMap(message.metadata) ? message.metadata : {},
  };
}

export function formatHistoryForLlm(
  messages: Array<Record<string, unknown>>,
  options?: {
    excludeId?: string;
    participants?: Array<Record<string, unknown>>;
  },
): ToolModelMessage[] {
  const excludeId = options?.excludeId;
  const participants = options?.participants;

  return messages
    .filter((message) => String(message.id ?? "") !== excludeId)
    .map((message) => formatMessageForLlm(message, participants));
}

/** Maps core's `ParticipantFields` (name/type optional) to the public `ParticipantRecord` (required strings). */
export function toParticipantRecord(fields: ParticipantFields): ParticipantRecord {
  return {
    id: fields.id,
    name: fields.name ?? "unknown",
    type: fields.type ?? "unknown",
    handle: fields.handle ?? null,
  };
}

export function toParticipantRecordFromRest(participant: ChatParticipant): ParticipantRecord {
  return {
    id: participant.id,
    name: participant.name,
    type: participant.type,
    handle: participant.handle ?? null,
  };
}

export function buildParticipantsMessage(participants: Array<Record<string, unknown>>): string {
  if (participants.length === 0) {
    return "## Current Participants\nNo other participants in this room.";
  }

  const lines = ["## Current Participants"];
  for (const participant of participants) {
    const participantType = String(participant.type ?? "Unknown");
    const participantName = String(participant.name ?? "Unknown");
    const participantHandle = String(participant.handle ?? "Unknown");
    lines.push(
      `- ${ensureHandlePrefix(participantHandle) ?? ""} — ${participantName} (${participantType})`,
    );
  }

  lines.push("");
  lines.push(
    "IMPORTANT: In band_send_message mentions, always use the exact handle shown above (e.g. '@john' for users, '@john/weather-agent' for agents), NOT the display name. Handles are lowercase with no spaces.",
  );

  return lines.join("\n");
}
