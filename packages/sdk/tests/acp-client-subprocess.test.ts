import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { ACPClientAdapter } from "../src/adapters/acp";
import { createSubprocessConnection } from "../src/adapters/acp/ACPRoomAgent";
import { BandACPClient } from "../src/adapters/acp/client";
import { FakeTools, expectTurnFailed, findFailureEvent, makeLoggerSpy, makeMessage } from "./testUtils";

const fakeAcpAgentPath = fileURLToPath(new URL("./fixtures/fakeAcpAgent.mjs", import.meta.url))
const MISSING_BINARY = "/nonexistent-band-agent"
// Well past the OS pipe buffer (64 KiB on Linux and macOS).
const STDERR_FLOOD_BYTES = 256 * 1024
// Reports its pid on stderr once SIGTERM is ignored, then never exits on its own.
const IGNORES_STOP_AGENT = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.error(process.pid)`

// These agents never ask for permission.
function unusedClient(): BandACPClient {
  return new BandACPClient(async () => ({ outcome: { outcome: "cancelled" } }))
}

function turn(adapter: ACPClientAdapter, tools: FakeTools): Promise<void> {
  return adapter.onMessage(
    makeMessage("hi"),
    tools,
    { roomToSession: {} },
    null,
    null,
    { isSessionBootstrap: true, roomId: "room-1" },
  )
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
    const adapter = new ACPClientAdapter({ command: [MISSING_BINARY], enableMcpTools: false })
    try {
      await expect(adapter.onStarted("Agent", "desc")).rejects.toThrow(/ENOENT/)

      for (let attempt = 0; attempt < 2; attempt++) {
        const tools = new FakeTools()
        await expectTurnFailed(turn(adapter, tools))
        expect(findFailureEvent(tools)?.content).toContain(`spawn ${MISSING_BINARY} ENOENT`)
      }
    } finally {
      await adapter.stop()
    }
  })

  it("keeps answering while the agent floods stderr, logging each line", async () => {
    const logger = makeLoggerSpy()
    const adapter = new ACPClientAdapter({
      command: [process.execPath, fakeAcpAgentPath],
      env: { FAKE_ACP_STDERR_BYTES: String(STDERR_FLOOD_BYTES) },
      enableMcpTools: false,
      logger,
    })
    try {
      await adapter.onStarted("Agent", "desc")
      const tools = new FakeTools()
      await turn(adapter, tools)

      expect(tools.messages.join("")).toContain("ok")
      expect(logger.debug).toHaveBeenCalledWith("acp_client.subprocess_stderr", { line: expect.stringMatching(/^x+$/) })
    } finally {
      await adapter.stop()
    }
  })
})
