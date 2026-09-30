import type { Logger } from "@band-ai/sdk/core";
import type {
  ElicitRequestFormParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  PluginStateStore,
  type CommandAuthorizationProfile,
} from "./state.js";

const COMMAND_PATTERN = /(?:^|\s)\/([A-Za-z0-9][A-Za-z0-9_.:-]*)/;
const DEFAULT_DENY_MINUTES = 60;
const MAX_DENY_MINUTES = 525_600;
const MAX_NOTE_LENGTH = 500;
const MAX_PREVIEW_LENGTH = 500;

const DECISIONS = [
  "run_once",
  "allow_command",
  "allow_all",
  "deny_once",
  "deny_timed",
] as const;

type CommandDecision = (typeof DECISIONS)[number];

export interface CommandAuthorizationRequest {
  senderId: string;
  senderName: string;
  command: string;
  content: string;
}

export interface CommandAuthorizationResult {
  allowed: boolean;
  note: string | null;
  source:
    | "owner"
    | "allow_all"
    | "allow_command"
    | "run_once"
    | "deny_once"
    | "deny_timed"
    | "unavailable";
}

export interface CommandAuthorizationHost {
  supportsFormElicitation(): boolean;
  elicitInput(params: ElicitRequestFormParams): Promise<ElicitResult>;
}

export function parsePrivilegedCommand(content: string): string | null {
  const match = COMMAND_PATTERN.exec(content);
  const name = match?.[1];
  return name === undefined ? null : `/${name.toLowerCase()}`;
}

export class PrivilegedCommandAuthorizer {
  private promptTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: {
      ownerId: string;
      profile: CommandAuthorizationProfile;
      state: PluginStateStore;
      host: CommandAuthorizationHost;
      logger: Logger;
      now?: () => number;
    },
  ) {}

  public async authorize(
    request: CommandAuthorizationRequest,
  ): Promise<CommandAuthorizationResult> {
    if (request.senderId === this.options.ownerId) {
      return { allowed: true, note: null, source: "owner" };
    }

    const operation = this.promptTail.then(
      () => this.authorizeSerialized(request),
      () => this.authorizeSerialized(request),
    );
    this.promptTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async authorizeSerialized(
    request: CommandAuthorizationRequest,
  ): Promise<CommandAuthorizationResult> {
    const stored = this.options.state.getCommandAccess(
      this.options.profile,
      request.senderId,
      request.command,
    );
    if (stored.kind === "allow_all" || stored.kind === "allow_command") {
      return { allowed: true, note: null, source: stored.kind };
    }
    if (stored.kind === "denied") {
      return { allowed: false, note: stored.note, source: "deny_timed" };
    }

    if (!this.options.host.supportsFormElicitation()) {
      this.options.logger.warn("denying privileged Band command: Claude client cannot prompt locally", {
        command: request.command,
        sender_id: request.senderId,
      });
      return { allowed: false, note: null, source: "unavailable" };
    }

    let response: ElicitResult;
    try {
      response = await this.options.host.elicitInput(buildAuthorizationPrompt(request));
    } catch (error) {
      this.options.logger.warn("denying privileged Band command: local authorization prompt failed", {
        command: request.command,
        sender_id: request.senderId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { allowed: false, note: null, source: "unavailable" };
    }

    if (response.action !== "accept") {
      return { allowed: false, note: null, source: "deny_once" };
    }

    const decision = parseDecision(response.content?.decision);
    const note = parseNote(response.content?.note);
    switch (decision) {
      case "run_once":
        return { allowed: true, note: null, source: "run_once" };
      case "allow_command":
        this.options.state.allowCommand(
          this.options.profile,
          request.senderId,
          request.command,
        );
        return { allowed: true, note: null, source: "allow_command" };
      case "allow_all":
        this.options.state.allowAllCommands(this.options.profile, request.senderId);
        return { allowed: true, note: null, source: "allow_all" };
      case "deny_timed": {
        const minutes = parseDenyMinutes(response.content?.deny_minutes);
        const now = this.options.now?.() ?? Date.now();
        this.options.state.denyCommandsUntil(
          this.options.profile,
          request.senderId,
          now + minutes * 60_000,
          note,
        );
        return { allowed: false, note, source: "deny_timed" };
      }
      case "deny_once":
        return { allowed: false, note, source: "deny_once" };
    }
  }
}

function buildAuthorizationPrompt(
  request: CommandAuthorizationRequest,
): ElicitRequestFormParams {
  const senderName = sanitizeForPrompt(request.senderName || "Unknown participant");
  const preview = sanitizeForPrompt(request.content);
  return {
    mode: "form",
    message:
      `Band participant ${senderName} (${request.senderId}) requested privileged command ` +
      `${request.command}. The command is blocked unless you authorize it.\n\nRequest: ${preview}`,
    requestedSchema: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          title: "Authorization",
          enum: [...DECISIONS],
          enumNames: [
            "Run once",
            `Always allow this participant to run ${request.command}`,
            "Always allow this participant to run any slash command",
            "Deny once",
            "Deny this participant for a period",
          ],
          default: "deny_once",
        },
        deny_minutes: {
          type: "integer",
          title: "Timed denial (minutes)",
          description: `Used only for a timed denial; defaults to ${DEFAULT_DENY_MINUTES} minutes.`,
          minimum: 1,
          maximum: MAX_DENY_MINUTES,
          default: DEFAULT_DENY_MINUTES,
        },
        note: {
          type: "string",
          title: "Optional denial note",
          description: "Sent to the requester in Band with an @mention when this decision denies the command.",
          maxLength: MAX_NOTE_LENGTH,
        },
      },
      required: ["decision"],
    },
  };
}

function parseDecision(value: unknown): CommandDecision {
  return typeof value === "string" && DECISIONS.some((decision) => decision === value)
    ? value as CommandDecision
    : "deny_once";
}

function parseDenyMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_DENY_MINUTES;
  return Math.min(Math.max(value, 1), MAX_DENY_MINUTES);
}

function parseNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim().slice(0, MAX_NOTE_LENGTH);
  return note.length > 0 ? note : null;
}

function sanitizeForPrompt(value: string): string {
  const sanitized = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > MAX_PREVIEW_LENGTH
    ? `${sanitized.slice(0, MAX_PREVIEW_LENGTH - 1)}…`
    : sanitized;
}
