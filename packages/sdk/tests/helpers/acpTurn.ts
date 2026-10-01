import type { ACPClientAdapter } from "../../src/adapters/acp";
import type { ACPClientSessionState } from "../../src/converters/acp-client";
import { FakeTools, makeMessage } from "../testUtils";

/** Starts the adapter and runs one bootstrap turn, the way the runtime delivers a room's first message. */
export async function runAcpTurn(
  adapter: ACPClientAdapter,
  options: { roomId?: string; tools?: FakeTools; content?: string; history?: ACPClientSessionState } = {},
): Promise<void> {
  const roomId = options.roomId ?? "room-1"
  await adapter.onStarted("Agent", "desc")
  await adapter.onMessage(
    makeMessage(options.content ?? "hi", roomId),
    options.tools ?? new FakeTools(),
    options.history ?? { roomToSession: {} },
    null,
    null,
    { isSessionBootstrap: true, roomId },
  )
}
