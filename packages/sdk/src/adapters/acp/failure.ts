import { AgentFailure } from "@band-ai/band-sdk-core";

import { FAILURE_METADATA_KEY } from "../../contracts/protocols";
import { agentFailure } from "../../core/providerFailure";
import {
  GATEWAY_FREE_TEXT_SENSITIVE_KEY_TERMS,
  redactCredentialText,
} from "../../core/sensitiveTerms";
import type { PlatformMessage } from "../../runtime/types";

const SENSITIVE_KEY_PATTERN = new RegExp(`^(?:${GATEWAY_FREE_TEXT_SENSITIVE_KEY_TERMS})$`, "i");
type JsonDetail = null | boolean | number | string | JsonDetail[] | JsonDetailObject;
interface JsonDetailObject { [key: string]: JsonDetail }

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
      ? redactDetail(parseJsonDetail(value.detail, new WeakSet()))
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

function parseJsonDetail(value: unknown, seen: WeakSet<object>): JsonDetail {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("Invalid failure detail");
  if (seen.has(value)) throw new Error("Cyclic failure detail");
  seen.add(value);

  let result: JsonDetail;
  if (Array.isArray(value)) {
    result = value.map((item) => parseJsonDetail(item, seen));
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("Invalid failure detail");
    }
    result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseJsonDetail(item, seen)]));
  }
  seen.delete(value);
  return result;
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
