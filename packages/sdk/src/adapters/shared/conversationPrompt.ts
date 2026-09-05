import type { HistoryProvider } from "../../runtime/types";

interface BuildConversationPromptOptions {
  history: HistoryProvider;
  isSessionBootstrap: boolean;
  participantsMessage: string | null;
  contactsMessage: string | null;
  historyHeader: string;
  currentMessage: string;
  maxHistoryMessages?: number;
}

// The current-turn roster/contacts update: `ExecutionContext.consumeParticipantsMessage`
// is edge-triggered, returning a value only on the turn the roster actually
// changed, so every adapter must inject whatever it's handed rather than
// gating on session bootstrap.
export function systemUpdateParts(participantsMessage: string | null, contactsMessage: string | null): string[] {
  const parts: string[] = [];

  if (participantsMessage) {
    parts.push(`[System]: ${participantsMessage}`);
  }

  if (contactsMessage) {
    parts.push(`[System]: ${contactsMessage}`);
  }

  return parts;
}

export function buildConversationPrompt(options: BuildConversationPromptOptions): string {
  const parts: string[] = [];

  if (options.isSessionBootstrap && options.history.length > 0) {
    const historyText = options.history.raw
      .slice(-(options.maxHistoryMessages ?? 50))
      .map(formatHistoryLine)
      .join("\n");
    parts.push(`${options.historyHeader}\n${historyText}`);
  }

  parts.push(...systemUpdateParts(options.participantsMessage, options.contactsMessage));

  parts.push(options.currentMessage);
  return parts.join("\n\n");
}

function formatHistoryLine(entry: Record<string, unknown>): string {
  const sender = String(entry.sender_name ?? entry.sender_type ?? "Unknown");
  const content = String(entry.content ?? "");
  return `[${sender}]: ${content}`;
}
