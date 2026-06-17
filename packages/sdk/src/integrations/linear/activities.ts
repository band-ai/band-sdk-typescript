import { LinearDocument as L } from "@linear/sdk";

export interface CandidateRepositoryInput {
  hostname: string;
  repositoryFullName: string;
}

export interface RepositorySuggestion {
  repositoryFullName: string;
  hostname?: string | null;
  confidence: number;
}

/**
 * Subset of `LinearClient` covering only the activity-reporting methods.
 */
export interface LinearActivityClient {
  createAgentActivity(input: {
    agentSessionId: string;
    content: Record<string, unknown>;
    ephemeral?: boolean;
  }): Promise<unknown>;
  updateAgentSession?: (
    id: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  updateIssue?: (
    issueId: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  createComment?: (
    input: { issueId: string; body: string },
  ) => Promise<unknown>;
  issue?: (issueId: string) => Promise<unknown>;
  workflowStates?: (variables?: Record<string, unknown>) => Promise<unknown>;
  issueRepositorySuggestions?: (
    candidateRepositories: CandidateRepositoryInput[],
    issueId: string,
    variables?: { agentSessionId?: string | null },
  ) => Promise<unknown>;
  agentSessionUpdateExternalUrl?: (
    id: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Create an agent session on an existing Linear issue (proactive initiation). */
  agentSessionCreateOnIssue?: (
    input: { issueId: string; externalLink?: string },
  ) => Promise<unknown>;
  /** Create an agent session on a specific comment thread (proactive initiation). */
  agentSessionCreateOnComment?: (
    input: { commentId: string; externalLink?: string },
  ) => Promise<unknown>;
  /** Create a new Linear issue from scratch. */
  createIssue?: (
    input: {
      teamId: string;
      title: string;
      description?: string;
      priority?: number;
      assigneeId?: string;
      stateId?: string;
      labelIds?: string[];
    },
  ) => Promise<unknown>;
}

export interface PlanStep {
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface SelectOption {
  label: string;
  value: string;
}

/** Longest body string allowed in an elicitation activity. */
export const ELICITATION_BODY_MAX_LENGTH = 10_000;

/** Longest label or value string allowed in a select option. */
export const SELECT_OPTION_MAX_LENGTH = 200;

/** Longest provider name string allowed in an auth elicitation. */
export const PROVIDER_MAX_LENGTH = 100;

async function postActivity(
  client: LinearActivityClient,
  sessionId: string,
  content: Record<string, unknown>,
  options?: { ephemeral?: boolean },
): Promise<void> {
  await client.createAgentActivity({
    agentSessionId: sessionId,
    content,
    ...(options?.ephemeral ? { ephemeral: true } : {}),
  });
}

async function postBodyActivity(
  client: LinearActivityClient,
  sessionId: string,
  type: L.AgentActivityType,
  body: string,
  options?: { ephemeral?: boolean },
): Promise<void> {
  await postActivity(client, sessionId, { type, body }, options);
}

export async function postThought(
  client: LinearActivityClient,
  sessionId: string,
  body: string,
  options?: { ephemeral?: boolean },
): Promise<void> {
  await postBodyActivity(client, sessionId, L.AgentActivityType.Thought, body, options);
}

export async function postError(
  client: LinearActivityClient,
  sessionId: string,
  body: string,
  options?: { ephemeral?: boolean },
): Promise<void> {
  await postBodyActivity(client, sessionId, L.AgentActivityType.Error, body, options);
}

export async function postResponse(
  client: LinearActivityClient,
  sessionId: string,
  body: string,
): Promise<void> {
  await postBodyActivity(client, sessionId, L.AgentActivityType.Response, body);
}

export async function postElicitation(
  client: LinearActivityClient,
  sessionId: string,
  body: string,
): Promise<void> {
  await postBodyActivity(client, sessionId, L.AgentActivityType.Elicitation, body);
}

export async function postSelectElicitation(
  client: LinearActivityClient,
  sessionId: string,
  body: string,
  options: SelectOption[],
): Promise<void> {
  await postActivity(client, sessionId, {
    type: L.AgentActivityType.Elicitation,
    body,
    signal: L.AgentActivitySignal.Select,
    signalMetadata: { options },
  });
}

export async function postAuthElicitation(
  client: LinearActivityClient,
  sessionId: string,
  body: string,
  url: string,
  provider?: string,
): Promise<void> {
  await postActivity(client, sessionId, {
    type: L.AgentActivityType.Elicitation,
    body,
    signal: L.AgentActivitySignal.Auth,
    signalMetadata: {
      url,
      ...(provider ? { provider } : {}),
    },
  });
}

export async function postAction(
  client: LinearActivityClient,
  sessionId: string,
  body: string,
  options?: { ephemeral?: boolean },
): Promise<void> {
  await postActivity(client, sessionId, {
    type: L.AgentActivityType.Action,
    action: body,
    parameter: "",
  }, options);
}

type LinearPlanStatus = "pending" | "inProgress" | "completed" | "canceled";

const PLAN_STATUS_MAP: Record<PlanStep["status"], LinearPlanStatus> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
  failed: "canceled",
};

export async function updatePlan(
  client: LinearActivityClient,
  sessionId: string,
  steps: PlanStep[],
): Promise<void> {
  if (typeof client.updateAgentSession === "function") {
    const plan = {
      steps: steps.map((step) => ({
        content: step.title,
        status: PLAN_STATUS_MAP[step.status],
      })),
    };

    try {
      await client.updateAgentSession(sessionId, { plan });
      return;
    } catch (err) {
      console.warn("updateAgentSession failed, falling back to legacy plan", err);
    }
  }

  const planSummary = steps
    .map((step) => {
      const icon =
        step.status === "completed" ? "\u2705" :
        step.status === "in_progress" ? "\u23f3" :
        step.status === "failed" ? "\u274c" :
        "\u2b1c";
      return `${icon} ${step.title}`;
    })
    .join("\n");

  await postActivity(client, sessionId, {
    type: L.AgentActivityType.Thought,
    body: `**Plan:**\n${planSummary}`,
  });
}
