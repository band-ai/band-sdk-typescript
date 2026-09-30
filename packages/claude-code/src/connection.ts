import { randomUUID } from "node:crypto";

import type { Logger } from "@band-ai/sdk/core";
import {
  errorResult,
  successResult,
  type McpToolRegistration,
  type McpToolResult,
} from "@band-ai/sdk/mcp";
import type {
  BandHumanAuth,
  BandHumanIdentity,
  BandOwnedAgent,
  OAuthCredentialStore,
} from "@band-ai/sdk/auth";
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

import {
  AGENT_LEASE_HEARTBEAT_MS,
  PluginStateStore,
  agentCredentialKey,
  humanScope,
  type ClaudeSessionContext,
} from "./state.js";

export interface ActiveBandRuntime {
  stop(): Promise<void>;
}

export interface ConnectionHost {
  supportsUrlElicitation(): boolean;
  elicitInput(params: ElicitRequestURLParams): Promise<ElicitResult>;
  createElicitationCompletionNotifier(elicitationId: string): () => Promise<void>;
}

export interface BandConnectionControllerOptions {
  auth: BandHumanAuth;
  credentials: OAuthCredentialStore;
  state: PluginStateStore;
  context: ClaudeSessionContext;
  startRuntime(input: {
    scope: string;
    agentId: string;
    apiKey: string;
    platformOrigin: string;
  }): Promise<ActiveBandRuntime>;
  logger: Logger;
}

export class BandConnectionController {
  private host: ConnectionHost | null = null;
  private identity: BandHumanIdentity | null = null;
  private active: { scope: string; agentId: string; runtime: ActiveBandRuntime } | null = null;
  private pendingSignIn: Promise<BandHumanIdentity | null> | null = null;
  private cancelPendingSignIn: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sessionMutationTail: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;

  public constructor(private readonly options: BandConnectionControllerOptions) {}

  public attachHost(host: ConnectionHost): void {
    this.host = host;
  }

  public registrations(): McpToolRegistration[] {
    return [
      {
        name: "band_authenticate",
        description:
          "Sign the human into Band in a browser. Use this before listing or selecting a Band identity.",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: () => this.execute(() => this.authenticate()),
      },
      {
        name: "band_connection_status",
        description:
          "Show whether this Claude session is authenticated and which Band agent identity it owns.",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: () => this.execute(() => this.status()),
      },
      {
        name: "band_list_agent_identities",
        description:
          "List Band agent identities owned by the signed-in human and whether each can be connected to this Claude session.",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: () => this.execute(() => this.listIdentities()),
      },
      {
        name: "band_connect_session",
        description:
          "Bind this Claude transcript to exactly one Band agent. Pass agent_id for an existing identity or new_agent_name to create one. confirm_key_rotation is required only when an existing identity has no credential on this machine; rotating invalidates its previous API key.",
        inputSchema: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "Existing Band agent UUID" },
            new_agent_name: { type: "string", description: "Name for a new external Band agent" },
            confirm_key_rotation: {
              type: "boolean",
              description: "Confirm destructive API-key rotation for an existing identity",
            },
          },
          required: [],
        },
        execute: (args) => this.enqueueSessionMutation(() => this.connect(args)),
      },
      {
        name: "band_sign_out",
        description:
          "Sign the human out of Band and stop this session's Band connection. The Claude-to-agent binding remains for the same account to resume later.",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: () => this.enqueueSessionMutation(() => this.signOut()),
      },
    ];
  }

  public async initialize(): Promise<void> {
    if (this.initialization === null) {
      this.initialization = this.restore();
    }
    await this.initialization;
  }

  public async promptForAuthentication(): Promise<void> {
    await this.initialize();
    if (
      this.identity !== null ||
      this.pendingSignIn !== null ||
      this.host === null ||
      !this.host.supportsUrlElicitation()
    ) {
      return;
    }
    await this.execute(() => this.authenticate());
  }

  private async restore(): Promise<void> {
    try {
      this.identity = await this.options.auth.restore();
      if (this.identity === null) return;
      const scope = humanScope(this.options.auth.platformOrigin, this.identity.id);
      const agentId = this.options.state.getBinding(scope, this.options.context);
      if (agentId === null) return;
      const apiKey = await this.options.credentials.get(agentCredentialKey(scope, agentId));
      if (apiKey === undefined) {
        this.options.logger.warn("Bound Band identity has no local credential", { agent_id: agentId });
        return;
      }
      await this.activate(scope, agentId, apiKey, false);
    } catch (error) {
      this.options.logger.warn("Could not restore Band human session", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public get isConnected(): boolean {
    return this.active !== null;
  }

  public async stop(): Promise<void> {
    this.cancelPendingSignIn?.();
    this.cancelPendingSignIn = null;
    this.pendingSignIn = null;
    await this.sessionMutationTail;
    await this.stopActive();
  }

  private async authenticate(): Promise<McpToolResult> {
    if (this.identity !== null) {
      return successResult(`Authenticated to Band as ${this.identity.handle ?? this.identity.id}.`);
    }
    if (this.pendingSignIn !== null) {
      return successResult("Band browser sign-in is already in progress.");
    }
    if (this.host === null) return errorResult("The MCP connection is not ready for browser sign-in.");

    const attempt = await this.options.auth.beginSignIn();
    this.cancelPendingSignIn = attempt.cancel;
    const complete = async (): Promise<BandHumanIdentity | null> => {
      const result = await attempt.result;
      if (!result.ok) {
        this.options.logger.warn("Band browser sign-in failed", { reason: result.reason });
        return null;
      }
      this.identity = result.identity;
      return result.identity;
    };
    const pendingSignIn = complete().finally(() => {
      if (this.pendingSignIn === pendingSignIn) this.pendingSignIn = null;
      if (this.cancelPendingSignIn === attempt.cancel) this.cancelPendingSignIn = null;
    });
    this.pendingSignIn = pendingSignIn;

    if (!this.host.supportsUrlElicitation()) {
      void pendingSignIn.catch(() => undefined);
      return successResult(
        `Open this URL to sign in to Band, then call band_connection_status: ${attempt.authorizationUrl.toString()}`,
      );
    }

    const elicitationId = randomUUID();
    const notifyComplete = this.host.createElicitationCompletionNotifier(elicitationId);
    try {
      const elicited = await this.host.elicitInput({
        mode: "url",
        message: "Sign in to Band to choose or create an agent for this Claude session.",
        elicitationId,
        url: attempt.authorizationUrl.toString(),
      });
      if (elicited.action !== "accept") {
        attempt.cancel();
        await pendingSignIn;
        return errorResult("Band sign-in was cancelled.");
      }
      const identity = await pendingSignIn;
      return identity === null
        ? errorResult("Band sign-in failed or expired.")
        : successResult(
            `Authenticated to Band as ${identity.handle ?? identity.id}. Call band_list_agent_identities next.`,
          );
    } catch (error) {
      attempt.cancel();
      await pendingSignIn.catch(() => undefined);
      throw error;
    } finally {
      await notifyComplete().catch((error: unknown) => {
        this.options.logger.warn("Failed to complete Band sign-in elicitation", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async status(): Promise<McpToolResult> {
    if (this.identity === null && this.pendingSignIn !== null) {
      const pending = await Promise.race([
        this.pendingSignIn,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      if (pending !== null) this.identity = pending;
      if (this.identity === null && this.pendingSignIn !== null) {
        return successResult("Band browser sign-in is still in progress.");
      }
    }
    if (this.active !== null) {
      return successResult(`Connected as Band agent ${this.active.agentId}.`);
    }
    if (this.identity !== null) {
      return successResult(
        `Authenticated as ${this.identity.handle ?? this.identity.id}, but this Claude session has no active Band identity.`,
      );
    }
    return successResult("Not authenticated to Band. Call band_authenticate.");
  }

  private async listIdentities(): Promise<McpToolResult> {
    const authenticated = await this.requireIdentity();
    if (!authenticated.ok) return authenticated.result;
    const scope = humanScope(this.options.auth.platformOrigin, authenticated.identity.id);
    const remote = await this.options.auth.client.listAgents();
    const local = new Set(this.options.state.listAgents(scope).map((agent) => agent.agentId));
    const binding = this.options.state.getBinding(scope, this.options.context);
    const lines = await Promise.all(remote.map(async (agent) => {
      const hasCredential = local.has(agent.id) &&
        await this.options.credentials.get(agentCredentialKey(scope, agent.id)) !== undefined;
      const state = binding === agent.id
        ? "bound to this Claude session"
        : this.options.state.leasedByAnotherSession(scope, this.options.context, agent.id)
          ? "in use by another Claude session"
          : hasCredential
            ? "available on this machine"
            : "requires confirmed API-key rotation";
      return `- ${agent.name} (${agent.id}): ${state}`;
    }));
    if (lines.length === 0) {
      return successResult("No external Band agents exist. Use band_connect_session with new_agent_name.");
    }
    return successResult(lines.join("\n"));
  }


  private async connect(args: Record<string, unknown>): Promise<McpToolResult> {
    if (this.active !== null) {
      return successResult(`This Claude session is already connected as ${this.active.agentId}.`);
    }
    const authenticated = await this.requireIdentity();
    if (!authenticated.ok) return authenticated.result;
    const existingId = typeof args.agent_id === "string" ? args.agent_id : undefined;
    const newName = typeof args.new_agent_name === "string" ? args.new_agent_name.trim() : undefined;
    if ((existingId === undefined) === (newName === undefined || newName.length === 0)) {
      return errorResult("Provide exactly one of agent_id or new_agent_name.");
    }
    const scope = humanScope(this.options.auth.platformOrigin, authenticated.identity.id);
    const boundAgentId = this.options.state.getBinding(scope, this.options.context);
    if (newName !== undefined && newName.length > 0 && boundAgentId !== null) {
      return errorResult(`This Claude transcript is already bound to Band agent ${boundAgentId}.`);
    }

    let selected: BandOwnedAgent;
    let apiKey: string;
    let leaseHeld = false;
    try {
      if (newName !== undefined && newName.length > 0) {
        const credential = await this.options.auth.client.registerAgent({
          name: newName,
          description: `Claude Code session for ${this.options.context.projectRoot}`,
        });
        selected = { id: credential.agentId, name: newName, slug: null };
        apiKey = credential.apiKey;
        await this.options.credentials.set(agentCredentialKey(scope, selected.id), apiKey);
        this.options.state.saveAgent(scope, { agentId: selected.id, name: selected.name });
      } else {
        const remote = await this.options.auth.client.listAgents();
        const match = remote.find((agent) => agent.id === existingId?.toLowerCase());
        if (match === undefined) {
          return errorResult("The selected Band agent is not owned by this account.");
        }
        selected = match;
        if (boundAgentId !== null && boundAgentId !== selected.id) {
          return errorResult(`This Claude transcript is already bound to Band agent ${boundAgentId}.`);
        }
        const key = agentCredentialKey(scope, selected.id);
        const candidate = await this.options.credentials.get(key);
        if (candidate === undefined && args.confirm_key_rotation !== true) {
          return errorResult(
            "This identity has no credential on this machine. Re-run with confirm_key_rotation=true only after the user confirms that rotating the API key will disconnect clients using the previous key.",
          );
        }
        if (!this.options.state.acquireLease(scope, this.options.context, selected.id)) {
          return errorResult("That Band identity is currently owned by another Claude session.");
        }
        leaseHeld = true;
        const stored = await this.options.credentials.get(key);
        if (stored === undefined) {
          const credential = await this.options.auth.client.regenerateAgentApiKey(selected.id);
          apiKey = credential.apiKey;
          await this.options.credentials.set(key, apiKey);
        } else {
          apiKey = stored;
        }
        this.options.state.saveAgent(scope, { agentId: selected.id, name: selected.name });
      }

      if (!leaseHeld) {
        if (!this.options.state.acquireLease(scope, this.options.context, selected.id)) {
          return errorResult("That Band identity is currently owned by another Claude session.");
        }
        leaseHeld = true;
      }
      await this.activate(scope, selected.id, apiKey, true, true);
      leaseHeld = false;
      return successResult(
        `Connected this Claude transcript to Band agent ${selected.name} (${selected.id}). Future resumes of this transcript will restore the same identity.`,
      );
    } finally {
      if (leaseHeld) {
        this.options.state.releaseLease(scope, this.options.context, selected!.id);
      }
    }
  }

  private async signOut(): Promise<McpToolResult> {
    await this.stopActive();
    await this.options.auth.signOut();
    this.identity = null;
    return successResult("Signed out of Band.");
  }

  private async requireIdentity(): Promise<
    | { ok: true; identity: BandHumanIdentity }
    | { ok: false; result: McpToolResult }
  > {
    if (this.identity !== null) return { ok: true, identity: this.identity };
    return { ok: false, result: errorResult("Authenticate first with band_authenticate.") };
  }

  private async enqueueSessionMutation(
    run: () => Promise<McpToolResult>,
  ): Promise<McpToolResult> {
    const operation = this.sessionMutationTail.then(() => this.execute(run));
    this.sessionMutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  private async execute(run: () => Promise<McpToolResult>): Promise<McpToolResult> {
    try {
      return await run();
    } catch (error) {
      this.options.logger.warn("Band connection operation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult(error instanceof Error ? error.message : "Band connection operation failed");
    }
  }

  private async activate(
    scope: string,
    agentId: string,
    apiKey: string,
    persistBinding: boolean,
    leaseAlreadyHeld = false,
  ): Promise<void> {
    if (
      !leaseAlreadyHeld &&
      !this.options.state.acquireLease(scope, this.options.context, agentId)
    ) {
      throw new Error("Band identity is already active in another Claude session");
    }
    let runtime: ActiveBandRuntime | null = null;
    try {
      runtime = await this.options.startRuntime({
        scope,
        agentId,
        apiKey,
        platformOrigin: this.options.auth.platformOrigin,
      });
      if (persistBinding) this.options.state.bind(scope, this.options.context, agentId);
      this.active = { scope, agentId, runtime };
      this.heartbeat = setInterval(() => {
        if (
          this.active !== null &&
          !this.options.state.heartbeatLease(
            this.active.scope,
            this.options.context,
            this.active.agentId,
          )
        ) {
          void this.stopActive().catch((error: unknown) => {
            this.options.logger.warn("Failed to stop Band runtime after losing its lease", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }, AGENT_LEASE_HEARTBEAT_MS);
      this.heartbeat.unref?.();
    } catch (error) {
      await runtime?.stop().catch((stopError: unknown) => {
        this.options.logger.warn("Failed to stop partially activated Band runtime", {
          error: stopError instanceof Error ? stopError.message : String(stopError),
        });
      });
      this.options.state.releaseLease(scope, this.options.context, agentId);
      throw error;
    }
  }

  private async stopActive(): Promise<void> {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const current = this.active;
    this.active = null;
    if (current === null) return;
    try {
      await current.runtime.stop();
    } finally {
      this.options.state.releaseLease(
        current.scope,
        this.options.context,
        current.agentId,
      );
    }
  }
}
