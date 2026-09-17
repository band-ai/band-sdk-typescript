import type {
  LettaClientLike,
  LettaMessageCreateParams,
  LettaResponse,
} from "../../src/adapters/letta/LettaAdapter";

/** Records Letta agent.create params for example contract tests. */
export class RecordingLettaClient implements LettaClientLike {
  public lastAgentCreateParams: Record<string, unknown> | undefined;

  public readonly agents: LettaClientLike["agents"] = {
    create: async (params: Record<string, unknown>) => {
      this.lastAgentCreateParams = params;
      return { id: "letta-agent-1" };
    },
    delete: async () => undefined,
    messages: {
      create: async (
        _agentId: string,
        _params: LettaMessageCreateParams,
      ): Promise<LettaResponse> => ({
        messages: [{ id: "m1", message_type: "assistant_message", content: "hi" }],
        stop_reason: { stop_reason: "end_turn" },
      }),
    },
  };
}
