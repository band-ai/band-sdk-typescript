import { describe, expect, it, vi } from "vitest";

import {
  postThought,
  postAction,
  postError,
  postResponse,
  postElicitation,
  postSelectElicitation,
  postAuthElicitation,
  updatePlan,
  type LinearActivityClient,
  type PlanStep,
} from "../src/integrations/linear/activities";

function makeMockClient(): LinearActivityClient & {
  calls: Array<{ agentSessionId: string; content: Record<string, unknown> }>;
  sessionUpdates: Array<{ id: string; input: Record<string, unknown> }>;
} {
  const calls: Array<{ agentSessionId: string; content: Record<string, unknown> }> = [];
  const sessionUpdates: Array<{ id: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    sessionUpdates,
    createAgentActivity: vi.fn(async (input) => {
      calls.push(input);
      return { ok: true };
    }),
    updateAgentSession: vi.fn(async (id: string, input: Record<string, unknown>) => {
      sessionUpdates.push({ id, input });
      return { success: true };
    }),
  };
}

describe("linear activities", () => {
  it("postThought calls createAgentActivity with thought type", async () => {
    const client = makeMockClient();
    await postThought(client, "session-1", "Thinking about the problem");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-1",
      content: { type: "thought", body: "Thinking about the problem" },
    });
  });

  it("postThought passes ephemeral flag as top-level field", async () => {
    const client = makeMockClient();
    await postThought(client, "session-1", "Thinking...", { ephemeral: true });

    expect(client.calls).toHaveLength(1);
    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      content: { type: "thought", body: "Thinking..." },
      ephemeral: true,
    });
  });

  it("postThought omits ephemeral when not set", async () => {
    const client = makeMockClient();
    await postThought(client, "session-1", "Important finding");

    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      content: { type: "thought", body: "Important finding" },
    });
  });

  it("postAction calls createAgentActivity with action type", async () => {
    const client = makeMockClient();
    await postAction(client, "session-2", "Searching codebase");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-2",
      content: { type: "action", action: "Searching codebase", parameter: "" },
    });
  });

  it("postAction passes ephemeral flag as top-level field", async () => {
    const client = makeMockClient();
    await postAction(client, "session-2", "Searching...", { ephemeral: true });

    expect(client.createAgentActivity).toHaveBeenCalledWith({
      agentSessionId: "session-2",
      content: { type: "action", action: "Searching...", parameter: "" },
      ephemeral: true,
    });
  });

  it("postError calls createAgentActivity with error type", async () => {
    const client = makeMockClient();
    await postError(client, "session-3", "Something went wrong");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-3",
      content: { type: "error", body: "Something went wrong" },
    });
  });

  it("postResponse calls createAgentActivity with response type", async () => {
    const client = makeMockClient();
    await postResponse(client, "session-4", "Here is the answer");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-4",
      content: { type: "response", body: "Here is the answer" },
    });
  });

  it("postElicitation calls createAgentActivity with elicitation type", async () => {
    const client = makeMockClient();
    await postElicitation(client, "session-5", "Could you clarify?");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-5",
      content: { type: "elicitation", body: "Could you clarify?" },
    });
  });

  it("updatePlan calls updateAgentSession with structured plan steps", async () => {
    const client = makeMockClient();
    const steps: PlanStep[] = [
      { title: "Analyze issue", status: "completed" },
      { title: "Search codebase", status: "in_progress" },
      { title: "Write fix", status: "pending" },
      { title: "Old approach", status: "failed" },
    ];

    await updatePlan(client, "session-6", steps);

    expect(client.calls).toHaveLength(0);
    expect(client.sessionUpdates).toHaveLength(1);
    expect(client.sessionUpdates[0]?.id).toBe("session-6");
    expect(client.sessionUpdates[0]?.input).toEqual({
      plan: {
        steps: [
          { content: "Analyze issue", status: "completed" },
          { content: "Search codebase", status: "inProgress" },
          { content: "Write fix", status: "pending" },
          { content: "Old approach", status: "canceled" },
        ],
      },
    });
  });

  it("updatePlan falls back to thought activity when updateAgentSession throws", async () => {
    const client = makeMockClient();
    client.updateAgentSession = vi.fn(async () => { throw new Error("mutation not found"); });
    const steps: PlanStep[] = [
      { title: "Analyze issue", status: "completed" },
      { title: "Search codebase", status: "in_progress" },
      { title: "Write fix", status: "pending" },
      { title: "Old approach", status: "failed" },
    ];

    await updatePlan(client, "session-6", steps);

    expect(client.updateAgentSession).toHaveBeenCalledOnce();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.agentSessionId).toBe("session-6");
    const body = (client.calls[0]?.content as { body: string }).body;
    expect(body).toContain("**Plan:**");
  });

  it("updatePlan falls back to thought activity when updateAgentSession is unavailable", async () => {
    const client = makeMockClient();
    delete (client as Partial<typeof client>).updateAgentSession;
    const steps: PlanStep[] = [
      { title: "Analyze issue", status: "completed" },
      { title: "Search codebase", status: "in_progress" },
      { title: "Write fix", status: "pending" },
      { title: "Old approach", status: "failed" },
    ];

    await updatePlan(client, "session-6", steps);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.agentSessionId).toBe("session-6");
    const body = (client.calls[0]?.content as { body: string }).body;
    expect(body).toContain("**Plan:**");
    expect(body).toContain("\u2705 Analyze issue");
    expect(body).toContain("\u23f3 Search codebase");
    expect(body).toContain("\u2b1c Write fix");
    expect(body).toContain("\u274c Old approach");
  });

  it("postSelectElicitation sends elicitation with select signal and options", async () => {
    const client = makeMockClient();
    const options = [
      { label: "Repo A", value: "repo-a" },
      { label: "Repo B", value: "repo-b" },
    ];
    await postSelectElicitation(client, "session-7", "Which repository?", options);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-7",
      content: {
        type: "elicitation",
        body: "Which repository?",
        signal: "select",
        signalMetadata: { options },
      },
    });
  });

  it("postAuthElicitation sends elicitation with auth signal and url", async () => {
    const client = makeMockClient();
    await postAuthElicitation(
      client,
      "session-8",
      "Please link your GitHub account",
      "https://github.com/login/oauth/authorize?client_id=abc",
      "GitHub",
    );

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      agentSessionId: "session-8",
      content: {
        type: "elicitation",
        body: "Please link your GitHub account",
        signal: "auth",
        signalMetadata: {
          url: "https://github.com/login/oauth/authorize?client_id=abc",
          provider: "GitHub",
        },
      },
    });
  });

  it("postAuthElicitation omits provider when not given", async () => {
    const client = makeMockClient();
    await postAuthElicitation(
      client,
      "session-9",
      "Please authenticate",
      "https://example.com/auth",
    );

    expect(client.calls).toHaveLength(1);
    const metadata = client.calls[0]?.content.signalMetadata as Record<string, unknown>;
    expect(metadata).toEqual({ url: "https://example.com/auth" });
    expect(metadata).not.toHaveProperty("provider");
  });
});
