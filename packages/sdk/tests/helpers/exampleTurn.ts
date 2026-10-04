import type { FrameworkAdapter } from "../../src/contracts/protocols";
import { AgentTools } from "../../src/runtime/tools/AgentTools";
import { RestFacade } from "../../src/client/rest/RestFacade";
import { HistoryProvider } from "../../src/runtime/types";
import type { ToolCallingModelRequest } from "../../src/adapters/tool-calling";
import { CaptureToolCallingModel } from "./captureToolCallingModel";
import { FakeRestApi, makeMessage, makeRoster } from "../testUtils";

export async function runToolCallingExampleTurn(
  adapter: FrameworkAdapter,
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

  await adapter.onEvent({
    message: makeMessage(userMessage, roomId),
    tools: tools.getAdapterTools(),
    history: new HistoryProvider([]),
    participantsMessage: null,
    contactsMessage: null,
    isSessionBootstrap: true,
    roomId,
  });

  const turn = capture.requests.at(-1);
  if (!turn) {
    throw new Error("expected a model turn");
  }
  return turn;
}

export function openAiToolNames(turn: ToolCallingModelRequest): string[] {
  return turn.tools.flatMap((schema) => {
    const fn = schema.function as { name?: string } | undefined;
    return typeof fn?.name === "string" ? [fn.name] : [];
  });
}
