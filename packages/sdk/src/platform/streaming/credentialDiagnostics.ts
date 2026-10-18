import { resolveLogger, type Logger } from "../../core/logger";
import { REDACTED_VALUE, SENSITIVE_KEY_TERMS, redactCredentialText } from "../../core/sensitiveTerms";
import { TransportError } from "../../core/errors";
import type { WebSocketDisconnectReason } from "./disconnectReason";

const SENSITIVE_KEY = new RegExp(SENSITIVE_KEY_TERMS, "i");

export function headerAuthEndpoint(address: string): { endpoint: URL; credentials: string[] } {
  let endpoint: URL;
  try {
    endpoint = new URL(address);
  } catch {
    throw new TransportError("Invalid Phoenix WebSocket endpoint.");
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TransportError("Phoenix WebSocket endpoint must not contain userinfo or a fragment.");
  }
  const credentials: string[] = [];
  const retained = new URLSearchParams();
  for (const [name, value] of endpoint.searchParams) {
    switch (name.toLowerCase()) {
      case "api_key":
        credentials.push(value);
        break;
      case "token":
        if (value.trim()) {
          throw new TransportError("Token query authentication cannot be combined with API-key header authentication.");
        }
        break;
      default:
        retained.append(name, value);
    }
  }
  endpoint.search = retained.toString();
  endpoint.pathname = endpoint.pathname.replace(/\/websocket\/?$/, "").replace(/\/$/, "");
  return { endpoint, credentials };
}

/** Owns the credential policy before diagnostics cross into caller loggers or errors. */
export class CredentialDiagnostics {
  private readonly secrets: RegExp[];

  public constructor(credentials: string[]) {
    this.secrets = [...new Set(credentials.filter(Boolean).flatMap((value) => {
      const encoded = encodeURIComponent(value);
      return [value, encoded, encodeURI(value), new URLSearchParams({ value }).toString().slice(6)];
    }))].sort((left, right) => right.length - left.length).map((value) => {
      const literal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = literal.replace(/%[0-9A-F]{2}/gi, (escape) => escape.replace(/[a-f]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`));
      return new RegExp(pattern, "g");
    });
  }

  public text(value: string): string {
    for (const secret of this.secrets) {
      value = value.replace(secret, REDACTED_VALUE);
    }
    return redactCredentialText(value);
  }

  public value(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return this.text(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (value instanceof Error) {
      return {
        name: this.text(value.name), message: this.text(value.message), stack: this.text(value.stack ?? ""),
        cause: this.value(value.cause, seen),
      };
    }
    if (Array.isArray(value)) return value.map((entry) => this.value(entry, seen));
    // Transport instances can retain the complete request and authentication headers.
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return "[Transport object]";
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      this.text(key), SENSITIVE_KEY.test(key) ? REDACTED_VALUE : this.value(entry, seen),
    ]));
  }

  public reason(reason: WebSocketDisconnectReason): WebSocketDisconnectReason {
    switch (reason.source) {
      case "upgrade":
        return { ...reason, message: this.text(reason.message), requestId: reason.requestId === null ? null : this.text(reason.requestId) };
      case "agent_control":
        return { ...reason, code: this.text(reason.code), message: this.text(reason.message),
          correlationId: reason.correlationId === null ? null : this.text(reason.correlationId),
          targetSocketId: reason.targetSocketId === null ? null : this.text(reason.targetSocketId) };
      case "websocket_close":
        return { ...reason, closeReason: reason.closeReason === null ? null : this.text(reason.closeReason) };
    }
  }

  public logger(logger?: Logger): Logger {
    if (!logger) return resolveLogger();
    const emit = (level: keyof Logger, message: string, context?: Record<string, unknown>): void => {
      return logger[level](this.text(message), this.value(context) as Record<string, unknown> | undefined);
    };
    return resolveLogger({
      debug: (message, context) => emit("debug", message, context),
      info: (message, context) => emit("info", message, context),
      warn: (message, context) => emit("warn", message, context),
      error: (message, context) => emit("error", message, context),
    });
  }
}
