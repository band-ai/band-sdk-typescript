import { AgentFailure } from "@band-ai/band-sdk-core";
import { z } from "zod";

import { FAILURE_METADATA_KEY } from "../../contracts/protocols";
import { agentFailure } from "../../core/providerFailure";
import {
  GATEWAY_FREE_TEXT_SENSITIVE_KEY_TERMS,
  redactCredentialText,
} from "../../core/sensitiveTerms";
import type { PlatformMessage } from "../../runtime/types";

const SENSITIVE_KEY_PATTERN = new RegExp(`^(?:${GATEWAY_FREE_TEXT_SENSITIVE_KEY_TERMS})$`, "i");
// z.json() accepts cycles, which cannot be forwarded through JSON-RPC.
const detailSchema = z.json().refine((value) => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
});
type JsonDetail = z.infer<typeof detailSchema>;

export function decodeACPFailure(message: PlatformMessage): AgentFailure {
  const fallback = () => agentFailure(
    "band",
    redactCredentialText(message.content.trim() || "Band peer reported a failure."),
  );
  const value = message.metadata?.[FAILURE_METADATA_KEY];
  if (!isRecord(value)
    || typeof value.provider !== "string" || !value.provider.trim()
    || typeof value.message !== "string" || !value.message.trim()
    || ("code" in value && value.code !== null && typeof value.code !== "string")) {
    return fallback();
  }

  try {
    // ACP clients need structured detail for debugging; preserve its JSON shape
    // while redacting credentials at every depth, as the Python gateway does.
    const detail = "detail" in value
      ? redactDetail(detailSchema.parse(value.detail))
      : undefined;
    return new AgentFailure(
      redactCredentialText(value.provider),
      redactCredentialText(value.message),
      typeof value.code === "string" ? redactCredentialText(value.code) : null,
      detail,
    );
  } catch {
    return fallback();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactDetail(value: JsonDetail): JsonDetail {
  if (typeof value === "string") return redactCredentialText(value);
  if (Array.isArray(value)) return value.map(redactDetail);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactDetail(item),
    ]));
  }
  return value;
}
