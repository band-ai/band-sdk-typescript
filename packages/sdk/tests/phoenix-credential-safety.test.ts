import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { ConsoleLogger, type Logger } from "../src/core/logger";
import { PhoenixChannelsTransport } from "../src/platform/streaming/PhoenixChannelsTransport";
import { createNodeWebSocketFactory } from "../src/platform/streaming/nodeWebSocketFactory";
import { FakePhoenixPeer } from "./fakePhoenixPeer";

const KEY = "synthetic-wire-key+/=credential";
const LEGACY_KEY = "synthetic-legacy-key+/=credential";

function captureLogger() {
  const records: unknown[] = [];
  const record: Logger["debug"] = (message, context) => records.push([message, context]);
  return { records, logger: { debug: record, info: record, warn: record, error: record } };
}

function containsCredential(value: unknown): boolean {
  const text = inspect(value, { depth: 20 });
  return [KEY, LEGACY_KEY].some((key) => [key, encodeURIComponent(key), encodeURIComponent(key).replace("%2B", "%2b")].some((value) => text.includes(value)));
}

describe("Phoenix credential safety at the wire and logger boundary", () => {
  it.each(["default", "custom"] as const)("uses headers on initial and reconnected %s sockets", async (factory) => {
    await using peer = await FakePhoenixPeer.start();
    const { logger, records } = captureLogger();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url,
      apiKey: KEY,
      agentId: "agent-1",
      logger,
      reconnectAfterMs: () => 10,
      ...(factory === "custom" ? { websocketFactory: createNodeWebSocketFactory({ "x-api-key": KEY }) } : {}),
    });
    try {
      await transport.connect();
      await transport.join("room:credential-check", {});
      peer.severAllConnections();
      await vi.waitFor(() => expect(peer.connectionCount).toBe(2));
      expect(peer.connectionHeaders.map((headers) => headers["x-api-key"] === KEY)).toEqual([true, true]);
      expect(containsCredential(peer.connectionUrls)).toBe(false);
      expect(containsCredential(records)).toBe(false);
    } finally {
      await transport.disconnect();
    }
  });

  it.each(["api_key", "API_KEY", "%61pi_key"])("removes %s credential parameters from a configured legacy endpoint", async (parameter) => {
    await using peer = await FakePhoenixPeer.start();
    const transport = new PhoenixChannelsTransport({
      wsUrl: `${peer.url}/websocket?${parameter}=${encodeURIComponent(LEGACY_KEY)}&API_KEY=old&trace=keep&trace=again`,
      apiKey: KEY,
      reconnectAfterMs: () => 10,
    });
    try {
      await transport.connect();
      await transport.join("room:legacy-credentials", {});
      peer.severAllConnections();
      await vi.waitFor(() => expect(peer.connectionCount).toBe(2));
      for (const url of peer.connectionUrls) {
        const request = new URL(url, peer.url);
        expect(containsCredential(request.href)).toBe(false);
        expect([...request.searchParams.keys()].some((name) => name.toLowerCase() === "api_key")).toBe(false);
        expect(request.pathname).toBe("/socket/websocket");
        expect(request.searchParams.getAll("trace")).toEqual(["keep", "again"]);
      }
      expect(peer.connectionHeaders.map((headers) => headers["x-api-key"] === KEY)).toEqual([true, true]);
    } finally {
      await transport.disconnect();
    }
  });

  it.each(["custom", "console"])("keeps refusal echoes out of %s logger records, returned errors and terminal state", async (loggerKind) => {
    const server = createServer();
    const requests: Array<{ url: string; authenticated: boolean }> = [];
    server.on("upgrade", (request, socket) => {
      requests.push({ url: request.url ?? "", authenticated: request.headers["x-api-key"] === KEY });
      const body = JSON.stringify({ error: {
        code: "connection_conflict",
        message: `refused ${KEY}`,
        request_id: encodeURIComponent(KEY).replace("%2B", "%2b"),
      } });
      socket.end(["HTTP/1.1 409 Conflict", "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, "", body].join("\r\n"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { logger, records } = captureLogger();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { records.push(args); });
    const consoleInfo = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { records.push(args); });
    const transport = new PhoenixChannelsTransport({
      wsUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket`,
      apiKey: KEY,
      logger: loggerKind === "custom" ? logger : new ConsoleLogger(),
    });
    try {
      const error = await transport.connect().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.authenticated).toBe(true);
      expect(containsCredential(requests)).toBe(false);
      expect(containsCredential(records)).toBe(false);
      expect(containsCredential(error)).toBe(false);
      expect(containsCredential(transport.getDisconnectReason())).toBe(false);
      expect(transport.getDisconnectReason()).toMatchObject({ status: 409, code: "connection_conflict" });
    } finally {
      await transport.disconnect();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      consoleWarn.mockRestore();
      consoleInfo.mockRestore();
    }
  });

  it.each(["?token=conflicting-token", "?TOKEN=conflicting-token", "#fragment", "userinfo"])("rejects ambiguous endpoint authentication: %s", (suffix) => {
    const wsUrl = suffix === "userinfo" ? "ws://user:password@localhost/socket" : `ws://localhost/socket${suffix}`;
    expect(() => new PhoenixChannelsTransport({ wsUrl, apiKey: KEY })).toThrow();
  });

  it("sanitizes control-event state and callbacks before consumers see them", async () => {
    await using peer = await FakePhoenixPeer.start();
    const { logger, records } = captureLogger();
    const terminal = vi.fn();
    const transport = new PhoenixChannelsTransport({
      wsUrl: peer.url, apiKey: KEY, agentId: "agent-1", logger, onTerminalDisconnect: terminal,
    });
    try {
      await transport.connect();
      await peer.endConnections("agent-1", "session.already_connected", `refused ${KEY}`);
      await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
      expect(containsCredential(terminal.mock.calls)).toBe(false);
      expect(containsCredential(transport.getDisconnectReason())).toBe(false);
      expect(containsCredential(records)).toBe(false);
    } finally {
      await transport.disconnect();
    }
  });

  it("sanitizes a real peer's close reason before caching and logging it", async () => {
    await using peer = await FakePhoenixPeer.start();
    const { logger, records } = captureLogger();
    const transport = new PhoenixChannelsTransport({ wsUrl: peer.url, apiKey: KEY, logger });
    try {
      await transport.connect();
      peer.closeConnections(1008, KEY);
      await vi.waitFor(() => expect(transport.getDisconnectReason()).toMatchObject({ source: "websocket_close", closeCode: 1008 }));
      expect(containsCredential(records)).toBe(false);
      expect(containsCredential(transport.getDisconnectReason())).toBe(false);
    } finally {
      await transport.disconnect();
    }
  });
});
