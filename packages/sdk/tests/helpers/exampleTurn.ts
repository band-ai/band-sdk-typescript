import type { AgentToolsProtocol } from "../../src/contracts/protocols";
import { AgentTools } from "../../src/runtime/tools/AgentTools";
import { RestFacade } from "../../src/client/rest/RestFacade";
import { HistoryProvider } from "../../src/runtime/types";
import type { ToolCallingModelRequest } from "../../src/adapters/tool-calling";
import { CaptureToolCallingModel } from "./captureToolCallingModel";
import { FakeRestApi, makeMessage, makeRoster } from "../testUtils";

interface ToolCallingExampleAdapter {
  onStarted(agentName: string, agentDescription: string): Promise<void>;
  onMessage(
    message: ReturnType<typeof makeMessage>,
    tools: AgentToolsProtocol,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void>;
}

export async function runToolCallingExampleTurn(
  adapter: ToolCallingExampleAdapter,
  capture: CaptureToolCallingModel,
  userMessage: string,
  roomId = "room-example",
): Promise<ToolCallingModelRequest> {
  await adapter.onStarted("Example Agent", "Band example");

  const tools = new AgentTools({
    roomId,
    rest: new RestFacade({ api: new FakeRestApi() }),
    roster: makeRoster([]),
  });

  await adapter.onMessage(
    makeMessage(userMessage, roomId),
    tools,
    new HistoryProvider([]),
    null,
    null,
    { isSessionBootstrap: true, roomId },
  );

  const turn = capture.requests.at(-1);
  if (!turn) {
    throw new Error("expected a model turn");
  }
  return turn;
}

export function openAiToolNames(turn: ToolCallingModelRequest): string[] {
  return turn.tools
    .map((schema) => schema.function?.name)
    .filter((name): name is string => typeof name === "string");
}
