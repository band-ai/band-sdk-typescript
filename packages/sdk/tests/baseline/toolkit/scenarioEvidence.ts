import type { AgentIdentity } from "./agents";
import { withTimeout } from "../../../src/adapters/shared/withTimeout";
import { failureEvidence } from "./failureEvidence";
import { history, MESSAGE_TYPE, readToolCalls, readToolResults, type CapturedMessage } from "./observeMessages";
import { currentProviderTrace } from "./providerDiagnostics";
import type { Room } from "./rooms";

const HISTORY_CAPTURE_TIMEOUT_MS = 2_000;

/** Durable results are collected before assertions; a timeout also retains already-captured frames. */
export function scenarioEvidence(room: Room, agent: AgentIdentity) {
  const providerTrace = currentProviderTrace();
  let messages: CapturedMessage[] | undefined;
  let extra: unknown;
  const read = async () => {
    messages = await history(room);
    const fromAgent = messages.filter((message) => message.senderId === agent.id);
    return {
      messages,
      calls: readToolCalls(fromAgent.filter((message) => message.messageType === MESSAGE_TYPE.ToolCall), { includeMemory: true }),
      results: readToolResults(fromAgent.filter((message) => message.messageType === MESSAGE_TYPE.ToolResult)),
      replies: fromAgent.filter((message) => message.messageType === MESSAGE_TYPE.Text),
    };
  };
  const evidence = failureEvidence(async () => {
    const captured = { roomId: room.id, agentId: agent.id, extra, providerTrace,
      frames: room.messages.entries, deliveryUpdates: room.deliveryUpdates.entries };
    try {
      if (!messages) await withTimeout(read(), HISTORY_CAPTURE_TIMEOUT_MS, "durable history capture timed out");
      return { ...captured, messages };
    } catch (error) {
      return { ...captured, historyError: error };
    }
  }, [agent.apiKey]);
  return { ...evidence, read, record: (value: unknown) => { extra = value; } };
}
