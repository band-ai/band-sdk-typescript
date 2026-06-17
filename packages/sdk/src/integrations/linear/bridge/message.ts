export type SessionIntent = "planning" | "implementation";

export function buildBridgeMessage(input: {
  sessionId: string;
  issueId: string | null;
  issueIdentifier: string | null | undefined;
  sessionStatus: string | null | undefined;
  sessionType: string | null | undefined;
  sessionCreatedAt: string | null | undefined;
  sessionUpdatedAt: string | null | undefined;
  action: "created" | "updated";
  hostHandle: string;
  promptContext: string | null | undefined;
  issueTitle: string | null | undefined;
  issueDescription: string | null | undefined;
  issueUrl: string | null | undefined;
  issueTeamKey: string | null | undefined;
  issueTeamName: string | null | undefined;
  issueTeamId: string | null | undefined;
  issueStateId: string | null | undefined;
  issueStateName: string | null | undefined;
  issueStateType: string | null | undefined;
  issueAssigneeId: string | null | undefined;
  issueAssigneeName: string | null | undefined;
  issueDelegateId: string | null | undefined;
  issueDelegateName: string | null | undefined;
  commentBody: string | null | undefined;
  commentId: string | null | undefined;
  sessionIntent: SessionIntent;
  suggestedPeerHandles: string[];
  webhookId: string | null | undefined;
  webhookTimestamp: number | null | undefined;
  oauthClientId: string | null | undefined;
  organizationId: string | null | undefined;
  appUserId: string | null | undefined;
  writebackMode: "final_only" | "activity_stream";
}): string {
  const header = input.action === "created"
    ? "[Linear]: Agent session created."
    : "[Linear]: Agent session updated.";
  const userRequest = firstNonEmpty(
    input.commentBody,
    input.promptContext,
    input.issueTitle ? `Please handle ${input.issueTitle}.` : null,
  ) ?? "Please handle this Linear request.";

  const issueIdLine = input.issueId ? `issue_id: ${input.issueId}` : "issue_id: none";
  const issueIdentifierLine = input.issueIdentifier
    ? `issue_identifier: ${input.issueIdentifier}`
    : "issue_identifier: none";
  const issueTitleLine = input.issueTitle ? `issue_title: ${input.issueTitle}` : "issue_title: none";
  const issueUrlLine = input.issueUrl ? `issue_url: ${input.issueUrl}` : "issue_url: none";
  const issueTeamLine = firstNonEmpty(input.issueTeamKey, input.issueTeamName)
    ? `issue_team: ${firstNonEmpty(input.issueTeamKey, input.issueTeamName)}`
    : "issue_team: none";
  const issueTeamIdLine = input.issueTeamId ? `issue_team_id: ${input.issueTeamId}` : "issue_team_id: none";
  const issueStateLine = firstNonEmpty(input.issueStateName, input.issueStateType)
    ? `issue_state: ${firstNonEmpty(input.issueStateName, input.issueStateType)}`
    : "issue_state: none";
  const issueStateIdLine = input.issueStateId ? `issue_state_id: ${input.issueStateId}` : "issue_state_id: none";
  const issueStateTypeLine = input.issueStateType ? `issue_state_type: ${input.issueStateType}` : "issue_state_type: none";
  const issueAssigneeLine = input.issueAssigneeName
    ? `issue_assignee: ${input.issueAssigneeName}`
    : "issue_assignee: none";
  const issueAssigneeIdLine = input.issueAssigneeId
    ? `issue_assignee_id: ${input.issueAssigneeId}`
    : "issue_assignee_id: none";
  const issueDelegateLine = input.issueDelegateName
    ? `issue_delegate: ${input.issueDelegateName}`
    : "issue_delegate: none";
  const issueDelegateIdLine = input.issueDelegateId
    ? `issue_delegate_id: ${input.issueDelegateId}`
    : "issue_delegate_id: none";
  const sessionStatusLine = input.sessionStatus ? `session_status: ${input.sessionStatus}` : "session_status: none";
  const sessionTypeLine = input.sessionType ? `session_type: ${input.sessionType}` : "session_type: none";
  const sessionCreatedLine = input.sessionCreatedAt
    ? `session_created_at: ${input.sessionCreatedAt}`
    : "session_created_at: none";
  const sessionUpdatedLine = input.sessionUpdatedAt
    ? `session_updated_at: ${input.sessionUpdatedAt}`
    : "session_updated_at: none";
  const appUserLine = input.appUserId ? `app_user_id: ${input.appUserId}` : "app_user_id: none";
  const organizationLine = input.organizationId
    ? `organization_id: ${input.organizationId}`
    : "organization_id: none";
  const oauthClientLine = input.oauthClientId
    ? `oauth_client_id: ${input.oauthClientId}`
    : "oauth_client_id: none";
  const webhookIdLine = input.webhookId ? `webhook_id: ${input.webhookId}` : "webhook_id: none";
  const webhookTimestampLine = typeof input.webhookTimestamp === "number"
    ? `webhook_timestamp: ${input.webhookTimestamp}`
    : "webhook_timestamp: none";
  const commentIdLine = input.commentId ? `comment_id: ${input.commentId}` : "comment_id: none";

  const promptContext = firstNonEmpty(input.promptContext) ?? "none";
  const issueDescription = firstNonEmpty(input.issueDescription) ?? "none";
  const commentBody = firstNonEmpty(input.commentBody) ?? "none";
  const suggestedPeersLine = input.suggestedPeerHandles.length > 0
    ? input.suggestedPeerHandles.map((handle) => `  - ${handle}`).join("\n")
    : "  - none";
  return `${userRequest}

${header}

Linear session context:
- session_id: ${input.sessionId}
- ${sessionStatusLine}
- ${sessionTypeLine}
- ${sessionCreatedLine}
- ${sessionUpdatedLine}
- ${issueIdLine}
- ${issueIdentifierLine}
- ${issueTitleLine}
- ${issueUrlLine}
- ${issueTeamLine}
- ${issueTeamIdLine}
- ${issueStateLine}
- ${issueStateIdLine}
- ${issueStateTypeLine}
- ${issueAssigneeLine}
- ${issueAssigneeIdLine}
- ${issueDelegateLine}
- ${issueDelegateIdLine}
- inferred_session_intent: ${input.sessionIntent}
- writeback_mode: ${input.writebackMode}
- ${appUserLine}
- ${organizationLine}
- ${oauthClientLine}
- ${webhookIdLine}
- ${webhookTimestampLine}

Bridge responsibilities:
- own orchestration for this Linear session
- decide whether you can answer alone or need help
- discover and invite specialists only when needed
- keep Linear updated with meaningful milestones
- use linear_post_thought and linear_post_action for meaningful progress updates
- call linear_post_response when the work is actually finished
- when you delegate inside Thenvoi, include the relevant ticket context in the room message so the specialist can act without hidden state

Suggested peers available in the registry right now. They are not in the room yet:
${suggestedPeersLine}

Prompt context:
${promptContext}

Issue description:
${issueDescription}

Linked comment:
- ${commentIdLine}
${commentBody}`;
}

export function extractPromptedResponseBody(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const activity = record.agentActivity;
  if (typeof activity !== "object" || activity === null) {
    return "";
  }

  const content = (activity as Record<string, unknown>).content;
  if (typeof content !== "object" || content === null) {
    return "";
  }

  const body = (content as Record<string, unknown>).body;
  return typeof body === "string" ? body : "";
}

export function detectSessionIntent(input: {
  issueStateType: string | null;
  promptContext: string | null | undefined;
  commentBody: string | null | undefined;
  issueTitle?: string | null | undefined;
  issueDescription?: string | null | undefined;
}): SessionIntent {
  if (input.issueStateType?.trim().toLowerCase() === "started") {
    return "implementation";
  }

  const explicitDirective = [
    input.promptContext,
    input.commentBody,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (/(please implement|implement (?:this|it|now|the)|build (?:this|it|now|the)|code (?:this|it|now|the)|ship (?:it|this)|start coding|start implementation|tighten|adjust|refine)/.test(explicitDirective)) {
    return "implementation";
  }

  return "planning";
}

export function extractIssueTeamKey(issue: unknown): string | null {
  const team = extractNestedRecord(issue, "team");
  return typeof team?.key === "string" ? team.key : null;
}

export function extractIssueTeamName(issue: unknown): string | null {
  const team = extractNestedRecord(issue, "team");
  return typeof team?.name === "string" ? team.name : null;
}

export function extractIssueTeamId(issue: unknown): string | null {
  const issueRecord = extractRecord(issue);
  if (typeof issueRecord?.teamId === "string") {
    return issueRecord.teamId;
  }

  const team = extractNestedRecord(issue, "team");
  return typeof team?.id === "string" ? team.id : null;
}

export function extractIssueStateField(issue: unknown, field: "id" | "name" | "type"): string | null {
  const state = extractNestedRecord(issue, "state");
  const value = state?.[field];
  return typeof value === "string" ? value : null;
}

export function extractIssueAssigneeField(issue: unknown, field: "id" | "name" | "displayName"): string | null {
  const assignee = extractNestedRecord(issue, "assignee");
  const value = assignee?.[field];
  return typeof value === "string" ? value : null;
}

export function extractIssueDelegateField(issue: unknown, field: "id" | "name" | "displayName"): string | null {
  const delegate = extractNestedRecord(issue, "delegate");
  const value = delegate?.[field];
  return typeof value === "string" ? value : null;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (!value) {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

function extractNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  const record = extractRecord(value);
  const nested = record?.[key];
  return extractRecord(nested);
}

function extractRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
