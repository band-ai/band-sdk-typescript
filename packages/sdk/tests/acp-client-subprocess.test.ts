import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { createSubprocessConnection } from "../src/adapters/acp/ACPRoomAgent";
import { BandACPClient } from "../src/adapters/acp/client";
import { runAcpTurn } from "./helpers/acpTurn";
import { FakeTools, expectTurnFailed, findFailureEvent, makeLoggerSpy, roomWorkspacePath, tmpRoot } from "./testUtils";

const fakeAcpAgentPath = fileURLToPath(new URL("./fixtures/fakeAcpAgent.mjs", import.meta.url))
const MISSING_BINARY = "/nonexistent-band-agent"
// Well past the OS pipe buffer (64 KiB on Linux and macOS).
const STDERR_FLOOD_BYTES = 256 * 1024
// Reports its pid on stderr once SIGTERM is ignored, then never exits on its own.
const IGNORES_STOP_AGENT = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.error(process.pid)`
const PID_FILE = "fake-acp-agent.pid"

// These agents never ask for permission.
function unusedClient(): BandACPClient {
  return new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))
}

function fakeAgentAdapter(root: string): ACPClientAdapter {
  return new ACPClientAdapter({
    cwd: root,
    command: [process.execPath, fakeAcpAgentPath],
    env: { FAKE_ACP_PID_FILE: PID_FILE },
    enableMcpTools: false,
  })
}

interface AgentReport {
  pid: number;
  cwd: string;
  session: string;
}

/** Runs one turn in `roomId` and returns what the fake agent said about itself. */
async function report(adapter: ACPClientAdapter, roomId: string): Promise<AgentReport> {
  const tools = new FakeTools()
  await runAcpTurn(adapter, { roomId, tools })
  const [, pid, cwd, session] = /^pid=(\d+) cwd=(.+) session=(.+)$/.exec(tools.messages.join(""))!
  return { pid: Number(pid), cwd: cwd!, session: session! }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("createSubprocessConnection", () => {
  it("rejects when the agent binary is missing", async () => {
    await expect(createSubprocessConnection(unusedClient(), { command: [MISSING_BINARY] }))
      .rejects.toThrow(/ENOENT/)
  })

  it("resolves stop when the ACP subprocess has already exited", async () => {
    const handle = await createSubprocessConnection(unusedClient(), {
      command: [process.execPath, "-e", ""],
    })
    await handle.connection.closed

    await expect(handle.stop()).resolves.toBeUndefined()
  })

  it("kills an agent that ignores both stdin closing and SIGTERM", async () => {
    const logger = makeLoggerSpy()
    const handle = await createSubprocessConnection(unusedClient(), {
      command: [process.execPath, "-e", IGNORES_STOP_AGENT],
      logger,
    })
    const pid = await vi.waitFor(() => {
      const [, { line }] = logger.debug.mock.calls.find(([event]) => event === "acp_client.subprocess_stderr")!
      return Number(line)
    })

    await handle.stop()

    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  })
})

describe("ACPClientAdapter over a real subprocess", () => {
  it("reports a missing agent binary in the room and retries it on the next turn", async () => {
    const adapter = new ACPClientAdapter({ cwd: tmpRoot(), command: [MISSING_BINARY], enableMcpTools: false })
    try {
      // Spawning waits for the room's first turn, so starting cannot fail on the binary.
      await adapter.onStarted("Agent", "desc")

      for (let attempt = 0; attempt < 2; attempt++) {
        const tools = new FakeTools()
        await expectTurnFailed(runAcpTurn(adapter, { tools }))
        expect(findFailureEvent(tools)?.content).toContain(`spawn ${MISSING_BINARY} ENOENT`)
      }
    } finally {
      await adapter.stop()
    }
  })

  it("keeps answering while the agent floods stderr, logging each line", async () => {
    const logger = makeLoggerSpy()
    const adapter = new ACPClientAdapter({
      cwd: tmpRoot(),
      command: [process.execPath, fakeAcpAgentPath],
      env: { FAKE_ACP_STDERR_BYTES: String(STDERR_FLOOD_BYTES) },
      enableMcpTools: false,
      logger,
    })
    try {
      const tools = new FakeTools()
      await runAcpTurn(adapter, { tools })

      expect(tools.messages.join("")).toMatch(/^pid=\d+/)
      expect(logger.debug).toHaveBeenCalledWith("acp_client.subprocess_stderr", { line: expect.stringMatching(/^x+$/) })
    } finally {
      await adapter.stop()
    }
  })

  it("runs each room in its own process, started and sessioned in that room's workspace", async () => {
    const root = tmpRoot()
    const adapter = fakeAgentAdapter(root)
    try {
      const roomA = await report(adapter, "room-a")
      const roomB = await report(adapter, "room-b")

      expect(roomA.pid).not.toBe(roomB.pid)
      expect(roomA).toMatchObject({ cwd: roomWorkspacePath(root, "room-a"), session: roomWorkspacePath(root, "room-a") })
      expect(roomB).toMatchObject({ cwd: roomWorkspacePath(root, "room-b"), session: roomWorkspacePath(root, "room-b") })
    } finally {
      await adapter.stop()
    }
  })

  it("stops only the leaving room's process, and every process on stop", async () => {
    const adapter = fakeAgentAdapter(tmpRoot())
    try {
      const roomA = await report(adapter, "room-a")
      const roomB = await report(adapter, "room-b")
      const roomC = await report(adapter, "room-c")

      await adapter.onCleanup("room-a")
      await vi.waitFor(() => expect(isAlive(roomA.pid)).toBe(false))
      expect(isAlive(roomB.pid)).toBe(true)

      await adapter.stop()
      expect([roomB.pid, roomC.pid].filter(isAlive)).toEqual([])
    } finally {
      await adapter.stop()
    }
  })

  it("starts a new process on the next turn after the room's process exits", async () => {
    const adapter = fakeAgentAdapter(tmpRoot())
    try {
      const first = await report(adapter, "room-1")
      process.kill(first.pid)
      await vi.waitFor(() => expect(isAlive(first.pid)).toBe(false))

      const second = await report(adapter, "room-1")

      expect(second.pid).not.toBe(first.pid)
      expect(second.cwd).toBe(first.cwd)
    } finally {
      await adapter.stop()
    }
  })

  it("leaves no process behind when stopped while a room's process is starting", async () => {
    const root = tmpRoot()
    const adapter = fakeAgentAdapter(root)
    const starting = runAcpTurn(adapter).catch(() => undefined)
    const pidFile = path.join(roomWorkspacePath(root, "room-1"), PID_FILE)
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))

    await adapter.stop()
    await starting

    const pid = Number(readFileSync(pidFile, "utf8"))
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false))
  })
})
