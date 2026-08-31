import type { HistoryConverter } from "../../contracts/protocols";
import { asNonEmptyString } from "../../core/coercion";
import { findLatestTaskMetadata } from "../shared/history";
import { ValidationError } from "../../core/errors";

export interface A2AAuth {
  apiKey?: string;
  bearerToken?: string;
  headers?: Record<string, string>;
}

export interface A2ASessionState {
  contextId: string | null;
  taskId: string | null;
  taskState: string | null;
}

export function buildA2AAuthHeaders(auth?: A2AAuth): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(auth?.headers ?? {})) {
    headers[key] = sanitizeHeaderValue(value, key);
  }

  if (auth?.apiKey) {
    headers["X-API-Key"] = sanitizeHeaderValue(auth.apiKey, "X-API-Key");
  }

  if (auth?.bearerToken) {
    headers.Authorization = `Bearer ${sanitizeHeaderValue(auth.bearerToken, "Authorization")}`;
  }

  return headers;
}

function sanitizeHeaderValue(value: string, headerName: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new ValidationError(`${headerName} header value must not contain CR or LF characters.`);
  }

  return value;
}

/**
 * Recovers the A2A context and task ids for a room from its task-event history, so the
 * adapter can resume an existing remote A2A conversation after a restart.
 */
export class A2AHistoryConverter implements HistoryConverter<A2ASessionState> {
  public convert(raw: Array<Record<string, unknown>>): A2ASessionState {
    const metadata = findLatestTaskMetadata(
      raw,
      (entry) => Object.prototype.hasOwnProperty.call(entry, "a2a_context_id"),
    );
    if (metadata) {
      return {
        contextId: asNonEmptyString(metadata.a2a_context_id),
        taskId: asNonEmptyString(metadata.a2a_task_id),
        taskState: asNonEmptyString(metadata.a2a_task_state),
      };
    }

    return {
      contextId: null,
      taskId: null,
      taskState: null,
    };
  }
}
