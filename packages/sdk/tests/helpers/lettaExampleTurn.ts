import type { LettaAdapter } from "../../src/adapters/letta/LettaAdapter";
import { makeMessage, type FakeTools } from "../testUtils";
import { turnInput } from "../turnOutcomeContract";

export async function runLettaExampleRoomTurn(
  adapter: LettaAdapter,
  tools: FakeTools,
  roomId = "room-letta",
): Promise<void> {
  await adapter.onStarted("Example Agent", "Letta example");
  await adapter.onEvent({ ...turnInput(tools, makeMessage("hello", roomId)), isSessionBootstrap: false });
}
