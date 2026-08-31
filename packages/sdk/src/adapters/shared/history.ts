import { asOptionalRecord } from "../../core/coercion";

export function findLatestTaskMetadata(
  raw: Array<Record<string, unknown>>,
  predicate: (metadata: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (let index = raw.length - 1; index >= 0; index -= 1) {
    const message = raw[index] ?? {};
    const messageType = String(message.message_type ?? message.messageType ?? "");
    if (messageType !== "task") {
      continue;
    }

    const metadata = asOptionalRecord(message.metadata) ?? {};
    if (predicate(metadata)) {
      return metadata;
    }
  }

  return null;
}
