import type { ACPClientConnectionFactory } from "../../src/adapters/acp/types";
import type { ACPClientAdapter } from "../../src/adapters/acp/ACPClientAdapter";
import { createAcpPromptCaptureHarness } from "./acpPromptCapture";
import { FakeTools, makeMessage } from "../testUtils";

export async function firstAcpSystemPrompt(
  buildAdapter: (connectionFactory: ACPClientConnectionFactory) => ACPClientAdapter,
  roomId = "room-acp-example",
): Promise<string> {
  const harness = createAcpPromptCaptureHarness();
  const adapter = buildAdapter(harness.connectionFactory);

  await adapter.onStarted("Example Agent", "ACP example");
  await adapter.onMessage(
    makeMessage("hello", roomId),
    new FakeTools(),
    { roomToSession: {} },
    null,
    null,
    { isSessionBootstrap: true, roomId },
  );

  return harness.promptTexts[0] ?? "";
}
