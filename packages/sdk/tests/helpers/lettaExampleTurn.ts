import type { LettaAdapter } from "../../src/adapters/letta/LettaAdapter";
import type { AgentToolsProtocol } from "../../src/contracts/protocols";
import { makeMessage } from "../testUtils";

export async function runLettaExampleRoomTurn(
  adapter: LettaAdapter,
  tools: AgentToolsProtocol,
  roomId = "room-letta",
): Promise<void> {
  await adapter.onStarted("Example Agent", "Letta example");
  await adapter.onMessage(
    makeMessage("hello", roomId),
    tools,
    [],
    null,
    null,
    { isSessionBootstrap: false, roomId },
  );
}
