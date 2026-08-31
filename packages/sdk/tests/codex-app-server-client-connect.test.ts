import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const createInterfaceMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("node:readline", () => ({
  createInterface: createInterfaceMock,
}));

interface FakeProc extends EventEmitter {
  stdin: {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdout: EventEmitter;
  stderr: EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  };
  kill: ReturnType<typeof vi.fn>;
}

function makeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdin = {
    write: vi.fn((_line: string, callback?: (error?: Error | null) => void) => {
      callback?.(null);
      return true;
    }),
    end: vi.fn(),
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter() as FakeProc["stderr"];
  proc.stderr.setEncoding = vi.fn();
  proc.kill = vi.fn();
  return proc;
}

describe("CodexAppServerStdioClient connect path", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    createInterfaceMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("connects over stdio, writes requests, and closes cleanly", async () => {
    const proc = makeProc();
    const stdoutLines = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    stdoutLines.close = vi.fn();
    spawnMock.mockReturnValue(proc);
    createInterfaceMock.mockReturnValue(stdoutLines);

    const logger = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const { CodexAppServerStdioClient } = await import("../src/adapters/codex/appServerClient");
    const client = new CodexAppServerStdioClient({
      command: ["codex-bin", "serve"],
      cwd: "/tmp/codex",
      env: { CODEX_FOO: "bar" },
      logger: logger as never,
    });

    await client.connect();
    await client.connect();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "codex-bin",
      ["serve"],
      expect.objectContaining({
        cwd: "/tmp/codex",
        stdio: ["pipe", "pipe", "pipe"],
        env: expect.objectContaining({
          CODEX_FOO: "bar",
        }),
      }),
    );
    expect(createInterfaceMock).toHaveBeenCalledWith({
      input: proc.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    expect(proc.stderr.setEncoding).toHaveBeenCalledWith("utf8");

    proc.stderr.emit("data", "  child log  ");
    proc.stderr.emit("data", "   ");
    expect(logger.debug).toHaveBeenCalledWith("codex_app_server.stderr", { text: "child log" });

    const requestPromise = client.request<{ ok: boolean }>("session/start", { fast: true });
    expect(proc.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ id: 1, method: "session/start", params: { fast: true } })}\n`,
      expect.any(Function),
    );

    stdoutLines.emit("line", JSON.stringify({ id: 1, result: { ok: true } }));
    await expect(requestPromise).resolves.toEqual({ ok: true });

    await client.notify("session/ping", { alive: true });
    await client.respond(9, { accepted: true });
    await client.respondError("req-1", 400, "bad request", { retryable: false });

    expect(proc.stdin.write).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({ method: "session/ping", params: { alive: true } })}\n`,
      expect.any(Function),
    );
    expect(proc.stdin.write).toHaveBeenNthCalledWith(
      3,
      `${JSON.stringify({ id: 9, result: { accepted: true } })}\n`,
      expect.any(Function),
    );
    expect(proc.stdin.write).toHaveBeenNthCalledWith(
      4,
      `${JSON.stringify({ id: "req-1", error: { code: 400, message: "bad request", data: { retryable: false } } })}\n`,
      expect.any(Function),
    );

    const eventPromise = client.recvEvent();
    stdoutLines.emit("line", JSON.stringify({ id: "tool-1", method: "tool/call", params: { name: "x" } }));
    await expect(eventPromise).resolves.toEqual({
      kind: "request",
      id: "tool-1",
      method: "tool/call",
      params: { name: "x" },
    });

    const closePromise = client.close();
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    proc.emit("close", 0, null);
    await closePromise;

    await expect(client.recvEvent()).resolves.toEqual({
      kind: "notification",
      method: "transport/closed",
      params: {
        reason: "Codex app-server closed by client.",
      },
    });
    expect(stdoutLines.close).toHaveBeenCalledTimes(1);
  });

  it("rejects empty commands and surfaces child process failures", async () => {
    const proc = makeProc();
    const stdoutLines = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    stdoutLines.close = vi.fn();
    spawnMock.mockReturnValue(proc);
    createInterfaceMock.mockReturnValue(stdoutLines);

    const { CodexAppServerStdioClient } = await import("../src/adapters/codex/appServerClient");

    await expect(
      new CodexAppServerStdioClient({ command: [] }).connect(),
    ).rejects.toThrow("Codex app-server command is empty");

    const client = new CodexAppServerStdioClient();
    await client.connect();

    const requestPromise = client.request("session/start");
    proc.emit("error", new Error("ENOENT"));

    await expect(requestPromise).rejects.toThrow("Codex app-server failed to start: ENOENT");
    await expect(client.recvEvent()).resolves.toEqual({
      kind: "notification",
      method: "transport/closed",
      params: {
        reason: "Codex app-server failed to start: ENOENT",
      },
    });
  });
});
