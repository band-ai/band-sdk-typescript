import { describe, expect, it } from "vitest";

import {
  assertNever,
  asErrorMessage,
  BandSdkError,
  RuntimeStateError,
  serializeError,
  TransportError,
  UnsupportedFeatureError,
  ValidationError,
} from "../src/core/errors";
import { ACPClientAdapter } from "../src/adapters/acp/ACPClientAdapter";
import { CodexJsonRpcError } from "../src/adapters/codex/appServerClient";
import { HttpStatusError } from "../src/adapters/opencode/client";
import { ContactEventHandlerError } from "../src/runtime/ContactEventHandler";
import {
  CustomToolDefinitionError,
  CustomToolExecutionError,
  CustomToolValidationError,
} from "../src/runtime/tools/customTools";
import { WebSocketDisconnectError } from "../src/platform/streaming/disconnectReason";
import { LazyAsyncValue } from "../src/adapters/shared/lazyAsyncValue";
import { getBandSdkMcpServerConfig } from "../src/mcp/backends";

describe("the SDK throws from its typed hierarchy, not bare Errors", () => {
  it("uses ValidationError for rejected arguments", () => {
    let caught: unknown;
    try {
      new ACPClientAdapter({ command: [] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toBeInstanceOf(BandSdkError);
    expect((caught as Error).message).toBe("ACPClientAdapter requires a command");
  });

  it("uses ValidationError for a malformed response shape", () => {
    let caught: unknown;
    try {
      getBandSdkMcpServerConfig({ kind: "http", server: {} } as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught).toBeInstanceOf(BandSdkError);
  });

  it("uses RuntimeStateError when something is used before it is ready", async () => {
    const lazy = new LazyAsyncValue({
      load: () => Promise.reject(new Error("upstream is down")),
      retryBackoffMs: 60_000,
    });

    await expect(lazy.get()).rejects.toThrow("upstream is down");

    const caught = await lazy.get().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(RuntimeStateError);
    expect(caught).toBeInstanceOf(BandSdkError);
  });

  it("uses BandSdkError for exhaustiveness fallbacks", () => {
    let caught: unknown;
    try {
      assertNever("unexpected" as never, "contact event");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BandSdkError);
    expect((caught as Error).message).toBe('Unhandled contact event: "unexpected"');
  });
});

describe("re-wrapped upstream errors keep the original as cause", () => {
  it("preserves reference equality through BandSdkError", () => {
    const original = new Error("upstream exploded");
    const wrapped = new BandSdkError("Tool round failed: upstream exploded", original);

    expect(wrapped.cause).toBe(original);
  });

  it("CustomToolExecutionError attaches the handler's error as cause", () => {
    const original = new Error("handler blew up");
    const wrapped = new CustomToolExecutionError("my_tool", original);

    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toBe("Custom tool my_tool failed: handler blew up");
  });
});

describe("optional cause on every error class", () => {
  const original = new Error("root cause");

  it.each([
    ["BandSdkError", () => new BandSdkError("x", original)],
    ["UnsupportedFeatureError", () => new UnsupportedFeatureError("x", original)],
    ["ValidationError", () => new ValidationError("x", original)],
    ["TransportError", () => new TransportError("x", original)],
    ["RuntimeStateError", () => new RuntimeStateError("x", original)],
  ])("%s passes cause through to Error", (_name, construct) => {
    expect(construct().cause).toBe(original);
  });

  it("omits cause entirely when none is supplied", () => {
    expect("cause" in new UnsupportedFeatureError("x")).toBe(false);
    expect("cause" in new RuntimeStateError("x")).toBe(false);
  });
});

describe("the SDK's own error classes join the BandSdkError hierarchy", () => {
  const instances: Array<[string, Error]> = [
    ["CodexJsonRpcError", new CodexJsonRpcError(-32000, "boom")],
    ["HttpStatusError", new HttpStatusError(503, { detail: "unavailable" })],
    ["ContactEventHandlerError", new ContactEventHandlerError({
      eventType: "contact_added",
      stage: "callback",
      retryable: true,
      cause: new Error("inner"),
    })],
    ["CustomToolDefinitionError", new CustomToolDefinitionError("bad definition")],
    ["CustomToolValidationError", new CustomToolValidationError("my_tool", ["name required"])],
    ["CustomToolExecutionError", new CustomToolExecutionError("my_tool", new Error("inner"))],
    ["WebSocketDisconnectError", new WebSocketDisconnectError({
      source: "websocket_close",
      code: "websocket.closed",
      message: "socket closed",
      retryable: true,
      closeCode: 1006,
      closeReason: null,
    })],
  ];

  it.each(instances)("%s extends BandSdkError", (_name, instance) => {
    expect(instance).toBeInstanceOf(BandSdkError);
    expect(instance).toBeInstanceOf(Error);
  });

  it("keeps the narrow HttpStatusError check working for the OpenCode retry path", () => {
    const error: unknown = new HttpStatusError(429, { detail: "slow down" });

    expect(error instanceof HttpStatusError).toBe(true);
    expect((error as HttpStatusError).status).toBe(429);
  });

  it("keeps ContactEventHandlerError's cause reachable after the reparent", () => {
    const inner = new Error("inner");
    const error = new ContactEventHandlerError({
      eventType: "contact_added",
      stage: "callback",
      retryable: true,
      cause: inner,
    });

    expect(error.cause).toBe(inner);
    expect(error.retryable).toBe(true);
  });
});

describe("shared error helpers", () => {
  it("asErrorMessage reads Error.message and stringifies anything else", () => {
    expect(asErrorMessage(new Error("boom"))).toBe("boom");
    expect(asErrorMessage("plain string")).toBe("plain string");
    expect(asErrorMessage(42)).toBe("42");
    expect(asErrorMessage(undefined)).toBe("undefined");
  });

  it("serializeError produces a structured payload, carrying retryable when present", () => {
    const error = Object.assign(new Error("boom"), { retryable: true });

    expect(serializeError(error)).toMatchObject({
      name: "Error",
      message: "boom",
      retryable: true,
    });
    expect(serializeError(error).stack).toBeTypeOf("string");
    expect(serializeError("not an error")).toEqual({ message: "not an error" });
    expect("retryable" in serializeError(new Error("plain"))).toBe(false);
  });
});
