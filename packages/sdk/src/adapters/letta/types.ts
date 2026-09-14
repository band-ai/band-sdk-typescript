import type { HistoryConverter } from "../../contracts/protocols";
import { asNonEmptyString } from "../shared/coercion";
import type { ChatTurn } from "../shared/history";

export interface LettaMessage extends ChatTurn {
  sender: string;
  senderType: string;
}

export type LettaMessages = LettaMessage[];

export class LettaHistoryConverter
  implements HistoryConverter<LettaMessages>
{
  public convert(raw: Array<Record<string, unknown>>): LettaMessages {
    const messages: LettaMessages = [];

    for (const entry of raw) {
      const messageType = asNonEmptyString(entry.message_type) ?? "text";
      if (messageType !== "text") {
        continue;
      }

      const content = asNonEmptyString(entry.content);
      if (!content) {
        continue;
      }

      const sender =
        asNonEmptyString(entry.sender_name) ??
        asNonEmptyString(entry.senderName) ??
        "";
      const senderType =
        asNonEmptyString(entry.sender_type) ??
        asNonEmptyString(entry.senderType) ??
        "User";
      const role =
        (asNonEmptyString(entry.role) ?? "user").toLowerCase() === "assistant"
          ? "assistant"
          : "user";

      if (role === "assistant") {
        messages.push({
          role,
          content,
          sender,
          senderType,
        });
        continue;
      }

      messages.push({
        role,
        content: sender ? `[${sender}]: ${content}` : content,
        sender,
        senderType,
      });
    }

    return messages;
  }
}
