import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerStdioClient,
  CodexJsonRpcError,
  type CodexRpcEvent,
} from "../src/adapters/codex/appServerClient";

interface ClientInternals {
  handleLine(line: string): Promise<void>;
  events: CodexRpcEvent[];
  pending: Map<number | string, { resolve(value: unknown): void; reject(error: Error): void }>;
  waiters: Array<{ resolve(event: CodexRpcEvent): void; reject(error: Error): void; timer: NodeJS.Timeout | null }>;
}

function getInternals(client: CodexAppServerStdioClient): ClientInternals {
  return client as unknown as ClientInternals;
}

describe("CodexAppServerStdioClient", () => {
  it("ignores request messages with invalid JSON-RPC ids", async () => {
    const client = new CodexAppServerStdioClient();
    const internals = getInternals(client);

    await internals.handleLine(JSON.stringify({
      id: { bad: true },
      method: "item/tool/call",
      params: {
        tool: "thenvoi_send_message",
      },
    }));

    expect(internals.events).toEqual([]);
  });

  it("queues request events when JSON-RPC ids are valid", async () => {
    const client = new CodexAppServerStdioClient();
    const internals = getInternals(client);

    await internals.handleLine(JSON.stringify({
      id: "req-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
      },
    }));

    expect(internals.events).toEqual([
      {
        kind: "request",
        id: "req-1",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
        },
      },
    ]);
  });

  it("rejects pending requests with CodexJsonRpcError from error payloads", async () => {
    const client = new CodexAppServerStdioClient();
    const internals = getInternals(client);
    const resolve = vi.fn();
    const reject = vi.fn();
    internals.pending.set(7, { resolve, reject });

    await internals.handleLine(JSON.stringify({
      id: 7,
      error: {
        code: -32002,
        message: "Thread expired",
        data: {
          threadId: "thread-1",
        },
      },
    }));

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    const error = reject.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(CodexJsonRpcError);
    expect((error as CodexJsonRpcError).code).toBe(-32002);
    expect((error as CodexJsonRpcError).data).toEqual({ threadId: "thread-1" });
  });

  it("rejects pending request/event waiters during explicit close", async () => {
    const client = new CodexAppServerStdioClient();
    const internals = getInternals(client);
    const requestReject = vi.fn();
    internals.pending.set("pending-1", { resolve: vi.fn(), reject: requestReject });

    const pendingEvent = client.recvEvent();
    expect(internals.waiters).toHaveLength(1);

    await client.close();

    await expect(pendingEvent).rejects.toThrow("Codex app-server closed by client.");
    expect(requestReject).toHaveBeenCalledTimes(1);
    expect(internals.pending.size).toBe(0);
    expect(internals.waiters).toHaveLength(0);
  });
});
