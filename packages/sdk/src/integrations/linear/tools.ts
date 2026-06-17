import { z } from "zod";

import type { Logger } from "../../core/logger";
import type { CustomToolDef } from "../../runtime/tools/customTools";
import type { CandidateRepositoryInput, LinearActivityClient, PlanStep, RepositorySuggestion, SelectOption } from "./activities";
import {
  ELICITATION_BODY_MAX_LENGTH,
  SELECT_OPTION_MAX_LENGTH,
  PROVIDER_MAX_LENGTH,
  postThought,
  postAction,
  postError,
  postElicitation,
  postSelectElicitation,
  postAuthElicitation,
  updatePlan,
} from "./activities";
import { completeLinearSession } from "./bridge";
import type { SessionRoomStore } from "./types";

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Zod refine predicate: allow https for any host, http only for localhost. */
function isAllowedAuthUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:") return true;
    return LOCALHOST_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

interface CreateLinearToolsOptions {
  client: LinearActivityClient;
  store?: SessionRoomStore;
  enableElicitation?: boolean;
  logger?: Logger;
}

/**
 * Create Linear activity tools usable by any adapter via `customTools`.
 */
export function createLinearTools(options: CreateLinearToolsOptions): CustomToolDef[] {
  const { client, store, enableElicitation = true, logger } = options;

  const sessionBodySchema = z.object({
    session_id: z.string().describe("The Linear agent session ID"),
    body: z.string().describe("The message body in Markdown format"),
  });
  const issueIdInputSchema = z.object({
    issue_id: z.string().optional().describe("The Linear issue ID (UUID) from the session context"),
  }).passthrough();
  const issueCommentLimitSchema = z.number().int().min(1).max(50).optional()
    .describe("Maximum number of recent comments to return");
  const requiredIssueIdSchema = issueIdInputSchema;
  const optionalIssueIdSchema = issueIdInputSchema;

  const tools: CustomToolDef[] = [];

  const ephemeralSessionBodySchema = sessionBodySchema.extend({
    ephemeral: z.boolean().optional().describe(
      "If true, this activity is displayed temporarily and replaced when the next activity arrives. " +
      "Use for transient status indicators like \"Thinking...\", \"Searching...\", or \"Waiting for response...\".",
    ),
  });

  const addSessionBodyTool = (
    name: string,
    description: string,
    activityFn: typeof postThought,
    options?: { supportsEphemeral?: boolean },
  ): void => {
    const supportsEphemeral = options?.supportsEphemeral ?? false;
    tools.push({
      name,
      description: supportsEphemeral
        ? description + " Set ephemeral: true for transient status updates that should disappear when the next activity arrives."
        : description,
      schema: supportsEphemeral ? ephemeralSessionBodySchema : sessionBodySchema,
      handler: async (args: Record<string, unknown>) => {
        await activityFn(
          client,
          args.session_id as string,
          args.body as string,
          supportsEphemeral && args.ephemeral === true ? { ephemeral: true } : undefined,
        );
        return { ok: true };
      },
    });
  };

  addSessionBodyTool(
    "linear_post_thought",
    "Post a thought to the Linear agent session, visible to the user as internal reasoning.",
    postThought,
    { supportsEphemeral: true },
  );

  addSessionBodyTool(
    "linear_post_action",
    "Post an action to the Linear agent session, showing the user what step is being taken.",
    postAction,
    { supportsEphemeral: true },
  );

  addSessionBodyTool(
    "linear_post_error",
    "Post an error to the Linear agent session to notify the user of a failure.",
    postError,
  );

  if (enableElicitation) {
    tools.push({
      name: "linear_ask_user",
      description: "Ask the Linear user a question. When options are provided, Linear renders them as a clickable picker (select signal); otherwise the user sees a free-text prompt.",
      schema: z.object({
        session_id: z.string().describe("The Linear agent session ID"),
        body: z.string().max(ELICITATION_BODY_MAX_LENGTH).describe("The question to ask, in Markdown format"),
        options: z.array(z.object({
          label: z.string().max(SELECT_OPTION_MAX_LENGTH).describe("Display text for the option"),
          value: z.string().max(SELECT_OPTION_MAX_LENGTH).describe("Value returned when the option is selected"),
        })).min(2).max(20).optional().describe("Clickable options for a select picker (2–20 items). Omit for free-text input."),
      }),
      handler: async (args: Record<string, unknown>) => {
        const sessionId = args.session_id as string;
        const body = args.body as string;
        // Zod .min(2) guarantees options is either undefined or has ≥2 items
        const options = args.options as SelectOption[] | undefined;
        if (options) {
          await postSelectElicitation(client, sessionId, body, options);
        } else {
          await postElicitation(client, sessionId, body);
        }
        return { ok: true };
      },
    });

    tools.push({
      name: "linear_select",
      description:
        "Present the Linear user with a set of clickable options via a select elicitation. " +
        "Use this instead of linear_ask_user when the user should pick from a known list of choices.",
      schema: z.object({
        session_id: z.string().describe("The Linear agent session ID"),
        body: z.string().describe("The question or prompt shown above the options (Markdown)"),
        options: z
          .array(
            z.object({
              label: z.string().describe("Display label for this option"),
              value: z.string().describe("Value returned when this option is selected"),
            }),
          )
          .min(1)
          .max(25)
          .describe("The selectable options"),
      }),
      handler: async (args: Record<string, unknown>) => {
        await postSelectElicitation(
          client,
          args.session_id as string,
          args.body as string,
          args.options as SelectOption[],
        );
        return { ok: true };
      },
    });

    tools.push({
      name: "linear_request_auth",
      description: "Ask the Linear user to link an external account by presenting an authentication button. The user sees a 'Link account' UI that opens the provided URL.",
      schema: z.object({
        session_id: z.string().describe("The Linear agent session ID"),
        body: z.string().max(ELICITATION_BODY_MAX_LENGTH).describe("Explanation of why authentication is needed, in Markdown format"),
        url: z.string().url().refine(
          isAllowedAuthUrl,
          { message: "URL must use https (http allowed only for localhost)" },
        ).describe("The authentication URL to open when the user clicks the link button"),
        provider: z.string().min(1).max(PROVIDER_MAX_LENGTH).optional().describe("Name of the external service (e.g. 'GitHub', 'Slack')"),
      }),
      handler: async (args: Record<string, unknown>) => {
        await postAuthElicitation(
          client,
          args.session_id as string,
          args.body as string,
          args.url as string,
          args.provider as string | undefined,
        );
        return { ok: true };
      },
    });
  }

  // linear_post_response is registered manually (not via addSessionBodyTool) because
  // its handler calls completeLinearSession which needs `store` — a different signature
  // than the postThought/postAction/postError functions that addSessionBodyTool expects.
  tools.push({
    name: "linear_post_response",
    description: "Post the final response to the Linear agent session and mark the session completed when a store is available.",
    schema: sessionBodySchema,
    handler: async (args: Record<string, unknown>) => {
      await completeLinearSession({
        linearClient: client,
        agentSessionId: args.session_id as string,
        body: args.body as string,
        store,
      });
      return { ok: true };
    },
  });

  tools.push(
    {
      name: "linear_update_plan",
      description: "Update the structured plan for the Linear agent session. Renders as a native checklist in the Linear Agent Session UI with live status indicators.",
      schema: z.object({
        session_id: z.string().describe("The Linear agent session ID"),
        steps: z.array(z.object({
          title: z.string().describe("Step title"),
          status: z.enum(["pending", "in_progress", "completed", "failed"]).describe("Step status"),
        })).describe("The plan steps with their current status"),
      }),
      handler: async (args: Record<string, unknown>) => {
        await updatePlan(
          client,
          args.session_id as string,
          args.steps as PlanStep[],
        );
        return { ok: true };
      },
    },
  );

  addIssueTools({
    tools,
    client,
    requiredIssueIdSchema,
    optionalIssueIdSchema,
    issueCommentLimitSchema,
  });

  if (typeof client.issueRepositorySuggestions === "function") {
    const suggestRepositories = client.issueRepositorySuggestions.bind(client);
    tools.push({
      name: "linear_suggest_repositories",
      description:
        "Ask Linear to rank candidate repositories by relevance for the current issue. " +
        "Returns ranked suggestions with confidence scores. Use this before asking the user " +
        "which repository to work in — if a suggestion has high confidence, auto-select it; " +
        "otherwise present the top options via the select elicitation signal.",
      schema: requiredIssueIdSchema.extend({
        session_id: z.string().describe("The Linear agent session ID"),
        repositories: z
          .array(
            z.object({
              hostname: z.string().describe("Hostname of the Git service (e.g. 'github.com')"),
              repositoryFullName: z.string().describe("Full name in owner/name format (e.g. 'acme/backend')"),
            }),
          )
          .min(1)
          .max(50)
          .describe("Candidate repositories the agent has access to"),
      }),
      handler: async (args: Record<string, unknown>) => {
        const issueId = resolveIssueId("linear_suggest_repositories", args);
        const sessionId = args.session_id as string;
        const candidates = args.repositories as CandidateRepositoryInput[];

        const response = await suggestRepositories(
          candidates,
          issueId,
          { agentSessionId: sessionId },
        );

        const suggestions = extractRepositorySuggestions(response);
        return { suggestions };
      },
    });
  }

  addSessionCreationTools({ tools, client, store, logger });

  return tools;
}

function addIssueTools(input: {
  tools: CustomToolDef[];
  client: LinearActivityClient;
  requiredIssueIdSchema: z.AnyZodObject;
  optionalIssueIdSchema: z.AnyZodObject;
  issueCommentLimitSchema: z.ZodOptional<z.ZodNumber>;
}): void {
  const {
    tools,
    client,
    requiredIssueIdSchema,
    optionalIssueIdSchema,
    issueCommentLimitSchema,
  } = input;

  tools.push(
    {
      name: "linear_get_issue",
      description: "Fetch the current Linear issue details using the exact issue UUID from the session context.",
      schema: requiredIssueIdSchema,
      handler: async (args: Record<string, unknown>) => {
        const issueId = resolveIssueId("linear_get_issue", args);
        return readIssue(client, issueId);
      },
    },
    {
      name: "linear_list_issue_comments",
      description: "List recent comments for the current Linear issue using the exact issue UUID from the session context.",
      schema: requiredIssueIdSchema.extend({ limit: issueCommentLimitSchema }),
      handler: async (args: Record<string, unknown>) => {
        const issueId = resolveIssueId("linear_list_issue_comments", args);
        return readIssueComments(client, issueId, typeof args.limit === "number" ? args.limit : 20);
      },
    },
    {
      name: "linear_list_workflow_states",
      description: "List workflow states for the current issue's team so the bridge can move the issue between Todo, In Progress, In Review, and Done.",
      schema: optionalIssueIdSchema.extend({
        team_id: z.string().optional().describe("The Linear team ID when already known from the issue context"),
      }),
      handler: async (args: Record<string, unknown>) => {
        const issueId = resolveOptionalIssueId("linear_list_workflow_states", args);

        const teamId = typeof args.team_id === "string" && args.team_id.trim().length > 0
          ? args.team_id
          : await readIssueTeamId(client, issueId);
        if (!teamId) {
          throw new Error("linear_list_workflow_states requires issue_id or team_id.");
        }

        return readWorkflowStates(client, teamId);
      },
    },
    {
      name: "linear_update_issue",
      description: "Update a Linear issue (title/description/state/assignee/priority/etc.) from the session workflow.",
      schema: requiredIssueIdSchema.extend({
        title: z.string().optional().describe("New issue title"),
        description: z.string().optional().describe("New issue description (Markdown)"),
        priority: z.number().int().min(0).max(4).optional().describe("Priority 0-4"),
        state_id: z.string().optional().describe("Workflow state ID"),
        assignee_id: z.string().nullable().optional().describe("Assignee user ID, or null to unassign"),
        delegate_id: z.string().nullable().optional().describe("Agent user ID to delegate the issue to, or null to clear delegate"),
        estimate: z.number().int().optional().describe("Estimate points"),
        due_date: z.string().optional().describe("Due date ISO string"),
      }),
      handler: async (args: Record<string, unknown>) => {
        if (typeof client.updateIssue !== "function") {
          throw new Error("linear_update_issue is unavailable: Linear client does not support updateIssue().");
        }
        const issueId = resolveIssueId("linear_update_issue", args);

        const hasUpdates = (
          args.title !== undefined
          || args.description !== undefined
          || args.priority !== undefined
          || args.state_id !== undefined
          || args.assignee_id !== undefined
          || args.delegate_id !== undefined
          || args.estimate !== undefined
          || args.due_date !== undefined
        );
        if (!hasUpdates) {
          throw new Error("linear_update_issue requires at least one update field.");
        }

        await client.updateIssue(
          issueId,
          {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.state_id !== undefined ? { stateId: args.state_id } : {}),
            ...(args.assignee_id !== undefined ? { assigneeId: args.assignee_id } : {}),
            ...(args.delegate_id !== undefined ? { delegateId: args.delegate_id } : {}),
            ...(args.estimate !== undefined ? { estimate: args.estimate } : {}),
            ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
          },
        );

        return { ok: true };
      },
    },
    {
      name: "linear_add_issue_comment",
      description: "Add a new comment to a Linear issue.",
      schema: requiredIssueIdSchema.extend({
        body: z.string().describe("Comment body (Markdown)"),
      }),
      handler: async (args: Record<string, unknown>) => {
        if (typeof client.createComment !== "function") {
          throw new Error("linear_add_issue_comment is unavailable: Linear client does not support createComment().");
        }
        const issueId = resolveIssueId("linear_add_issue_comment", args);

        await client.createComment({
          issueId,
          body: args.body as string,
        });

        return { ok: true };
      },
    },
  );
}

function assertUuid(toolName: string, value: string): void {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(value)) {
    throw new Error(`${toolName} requires the exact Linear UUID from the session context (not the human-readable identifier). Received "${value}".`);
  }
}

function resolveIssueId(toolName: string, args: Record<string, unknown>): string {
  const issueId = resolveOptionalIssueId(toolName, args);
  if (!issueId) {
    throw new Error(`${toolName} requires issue_id.`);
  }

  return issueId;
}

function resolveOptionalIssueId(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (typeof args.issue_id !== "string" || args.issue_id.length === 0) {
    return undefined;
  }

  assertUuid(toolName, args.issue_id);
  return args.issue_id;
}

interface LinearIssueSnapshot {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  priority?: number | null;
  estimate?: number | null;
  dueDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  state?: { id?: string | null; name?: string | null; type?: string | null } | null;
  assignee?: { id?: string | null; name?: string | null; displayName?: string | null } | null;
  delegate?: { id?: string | null; name?: string | null; displayName?: string | null } | null;
  delegateId?: string | null;
  team?: { id?: string | null; key?: string | null; name?: string | null } | null;
}

async function readIssue(client: LinearActivityClient, issueId: string): Promise<unknown> {
  if (typeof client.issue !== "function") {
    throw new Error("linear_get_issue is unavailable: Linear client does not support issue().");
  }

  const issue = await client.issue(issueId) as LinearIssueSnapshot;

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title ?? null,
      description: issue.description ?? null,
      url: issue.url ?? null,
      priority: issue.priority ?? null,
      estimate: issue.estimate ?? null,
      due_date: issue.dueDate ?? null,
      created_at: issue.createdAt ?? null,
      updated_at: issue.updatedAt ?? null,
      state: issue.state
        ? {
          id: issue.state.id ?? null,
          name: issue.state.name ?? null,
          type: issue.state.type ?? null,
        }
        : null,
      assignee: issue.assignee
        ? {
          id: issue.assignee.id ?? null,
          name: issue.assignee.displayName ?? issue.assignee.name ?? null,
        }
        : null,
      delegate: issue.delegate
        ? {
          id: issue.delegate.id ?? null,
          name: issue.delegate.displayName ?? issue.delegate.name ?? null,
        }
        : null,
      delegate_id: issue.delegateId ?? null,
      team: issue.team
        ? {
          id: issue.team.id ?? null,
          key: issue.team.key ?? null,
          name: issue.team.name ?? null,
        }
        : null,
    },
  };
}

async function readIssueComments(
  client: LinearActivityClient,
  issueId: string,
  limit: number,
): Promise<unknown> {
  if (typeof client.issue !== "function") {
    throw new Error("linear_list_issue_comments is unavailable: Linear client does not support issue().");
  }

  const issue = await client.issue(issueId) as {
    comments?: () => Promise<{ nodes?: Array<{
      id?: string | null;
      body?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      user?: { id?: string | null; name?: string | null; displayName?: string | null } | null;
    }> }>;
  };

  if (typeof issue.comments !== "function") {
    throw new Error("linear_list_issue_comments is unavailable: issue.comments() is not supported by the Linear client.");
  }

  const response = await issue.comments();
  const comments = (response.nodes ?? [])
    .slice(-limit)
    .map((comment) => ({
      id: comment.id ?? null,
      body: comment.body ?? null,
      created_at: comment.createdAt ?? null,
      updated_at: comment.updatedAt ?? null,
      user: comment.user
        ? {
          id: comment.user.id ?? null,
          name: comment.user.displayName ?? comment.user.name ?? null,
        }
        : null,
    }));

  return { comments };
}

async function readIssueTeamId(
  client: LinearActivityClient,
  issueId: string | undefined,
): Promise<string | null> {
  if (!issueId) {
    return null;
  }

  if (typeof client.issue !== "function") {
    throw new Error("linear_list_workflow_states is unavailable: Linear client does not support issue().");
  }

  const issue = await client.issue(issueId) as {
    teamId?: string | null;
    team?: { id?: string | null } | null;
  };

  return issue.teamId ?? issue.team?.id ?? null;
}

async function readWorkflowStates(
  client: LinearActivityClient,
  teamId: string,
): Promise<unknown> {
  if (typeof client.workflowStates !== "function") {
    throw new Error(
      "linear_list_workflow_states is unavailable: Linear client does not support workflowStates().",
    );
  }

  const response = await client.workflowStates({ teamId }) as {
    nodes?: Array<{
      id?: string | null;
      name?: string | null;
      type?: string | null;
      position?: number | null;
      teamId?: string | null;
    }>;
  };

  const states = (response.nodes ?? [])
    .map((state) => ({
      id: state.id ?? null,
      name: state.name ?? null,
      type: state.type ?? null,
      position: state.position ?? null,
      team_id: state.teamId ?? teamId,
    }))
    .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER));

  return { team_id: teamId, states };
}

function addSessionCreationTools(input: {
  tools: CustomToolDef[];
  client: LinearActivityClient;
  store?: SessionRoomStore;
  logger?: Logger;
}): void {
  const { tools, client, store, logger } = input;

  const sessionCreationBaseSchema = z.object({
    external_link: z.string().url().optional().describe("Optional URL of an external page associated with this session"),
    room_id: z.string().min(1).optional().describe("The Thenvoi room ID to persist the session-room mapping. Pass this when creating a session from within a Thenvoi conversation."),
  });

  const sessionCreationSchema = sessionCreationBaseSchema.extend({
    issue_id: z.string().uuid().describe("The Linear issue ID (UUID)"),
  });

  async function persistSessionRoom(
    sessionId: string,
    issueId: string | null,
    roomId: string | undefined,
  ): Promise<string | null> {
    if (!store || typeof roomId !== "string") return null;
    try {
      // Timestamps reflect the SDK host clock, not Linear's server clock.
      const now = new Date().toISOString();
      await store.upsert({
        linearSessionId: sessionId,
        linearIssueId: issueId,
        thenvoiRoomId: roomId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return null;
    } catch (err) {
      logger?.warn("linear_tools.session_room_persist_failed", {
        sessionId,
        issueId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
      return "session-room mapping not persisted";
    }
  }

  const createOnIssue = client.agentSessionCreateOnIssue?.bind(client);
  if (typeof createOnIssue === "function") {
    tools.push({
      name: "linear_create_session_on_issue",
      description:
        "Create a new Linear agent session on an existing issue. Use this when the conversation produces work that should be tracked against a known Linear issue and no session exists yet.",
      schema: sessionCreationSchema,
      handler: async (args: Record<string, unknown>) => {
        const issueId = args.issue_id as string;
        const result = await createOnIssue({
          issueId,
          ...(typeof args.external_link === "string" ? { externalLink: args.external_link } : {}),
        });
        const session = extractCreatedSession(result, logger);
        const warning = await persistSessionRoom(session.id, session.issueId, args.room_id as string | undefined);
        return { ok: true, session, ...(warning ? { warning } : {}) };
      },
    });
  }

  const createOnComment = client.agentSessionCreateOnComment?.bind(client);
  if (typeof createOnComment === "function") {
    tools.push({
      name: "linear_create_session_on_comment",
      description:
        "Create a new Linear agent session on a specific comment thread. Use this to attach agent work to an existing discussion on a Linear issue.",
      schema: sessionCreationBaseSchema.extend({
        comment_id: z.string().uuid().describe("The Linear comment ID (UUID)"),
      }),
      handler: async (args: Record<string, unknown>) => {
        const commentId = args.comment_id as string;
        const result = await createOnComment({
          commentId,
          ...(typeof args.external_link === "string" ? { externalLink: args.external_link } : {}),
        });
        const session = extractCreatedSession(result, logger);
        const warning = await persistSessionRoom(session.id, session.issueId, args.room_id as string | undefined);
        return { ok: true, session, ...(warning ? { warning } : {}) };
      },
    });
  }

  const createIssueFn = client.createIssue?.bind(client);
  if (typeof createIssueFn === "function") {
    tools.push({
      name: "linear_create_issue",
      description:
        "Create a new Linear issue from scratch. Use this when the Thenvoi conversation produces work that should be tracked as a new Linear issue. " +
        "After creating the issue, call linear_create_session_on_issue to attach an agent session. " +
        "Never create issues without explicit human intent or clear delegation.",
      schema: z.object({
        team_id: z.string().uuid().describe("The Linear team ID to create the issue in"),
        title: z.string().min(1).describe("Issue title"),
        description: z.string().optional().describe("Issue description in Markdown"),
        priority: z.number().int().min(0).max(4).optional().describe("Priority 0-4 (0=none, 1=urgent, 2=high, 3=normal, 4=low)"),
        assignee_id: z.string().uuid().optional().describe("Assignee user ID (UUID)"),
        state_id: z.string().uuid().optional().describe("Workflow state ID (UUID)"),
        label_ids: z.array(z.string().uuid()).optional().describe("Label IDs to attach (UUIDs)"),
      }),
      handler: async (args: Record<string, unknown>) => {
        const result = await createIssueFn({
          teamId: args.team_id as string,
          title: args.title as string,
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.priority === "number" ? { priority: args.priority } : {}),
          ...(typeof args.assignee_id === "string" ? { assigneeId: args.assignee_id } : {}),
          ...(typeof args.state_id === "string" ? { stateId: args.state_id } : {}),
          ...(Array.isArray(args.label_ids) ? { labelIds: args.label_ids as string[] } : {}),
        });

        const issue = extractCreatedIssue(result, logger);
        return { ok: true, issue };
      },
    });
  }
}

/**
 * Defensively extract session fields from an untyped Linear API response.
 * The Linear SDK may return a typed object, but we cast to Record<string, unknown>
 * intentionally so the extraction is resilient to SDK version changes.
 */
function extractCreatedSession(result: unknown, logger?: Logger): {
  id: string;
  issueId: string | null;
  status: string | null;
} {
  const payload = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  const session = typeof payload.agentSession === "object" && payload.agentSession !== null
    ? payload.agentSession as Record<string, unknown>
    : payload;

  const id = typeof session.id === "string" ? session.id : null;
  if (!id) {
    logger?.error("linear_tools.orphan_session_created", {
      raw: safeStringify(result),
    });
    throw new Error("Linear API returned a session without an ID.");
  }

  return {
    id,
    issueId: typeof session.issueId === "string" ? session.issueId : null,
    status: typeof session.status === "string" ? session.status : null,
  };
}

/**
 * Defensively extract issue fields from an untyped Linear API response.
 * See {@link extractCreatedSession} for rationale on the casting approach.
 */
function extractCreatedIssue(result: unknown, logger?: Logger): {
  id: string;
  identifier: string | null;
  url: string | null;
  title: string | null;
} {
  const payload = typeof result === "object" && result !== null ? result as Record<string, unknown> : {};
  const issue = typeof payload.issue === "object" && payload.issue !== null
    ? payload.issue as Record<string, unknown>
    : payload;

  const id = typeof issue.id === "string" ? issue.id : null;
  if (!id) {
    logger?.error("linear_tools.orphan_issue_created", {
      raw: safeStringify(result),
    });
    throw new Error("Linear API returned an issue without an ID.");
  }

  return {
    id,
    identifier: typeof issue.identifier === "string" ? issue.identifier : null,
    url: typeof issue.url === "string" ? issue.url : null,
    title: typeof issue.title === "string" ? issue.title : null,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractRepositorySuggestions(response: unknown): RepositorySuggestion[] {
  if (response == null || typeof response !== "object") {
    return [];
  }

  const payload = response as { suggestions?: unknown };
  if (!Array.isArray(payload.suggestions)) {
    return [];
  }

  return payload.suggestions
    .filter((entry): entry is Record<string, unknown> =>
      entry != null &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).repositoryFullName === "string",
    )
    .map((entry) => ({
      repositoryFullName: entry.repositoryFullName as string,
      hostname: typeof entry.hostname === "string" ? entry.hostname : null,
      confidence: typeof entry.confidence === "number" ? entry.confidence : 0,
    }))
    .sort((a, b) => b.confidence - a.confidence);
}
