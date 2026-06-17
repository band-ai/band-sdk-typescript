import type { FrameworkAdapter, Preprocessor } from "../contracts/protocols";
import type { ContactEvent, PlatformEvent } from "../platform/events";
import { ThenvoiLink, type ThenvoiLinkOptions } from "../platform/ThenvoiLink";
import { AgentRuntime } from "./rooms/AgentRuntime";
import type { AgentConfig, ContactEventConfig, SessionConfig } from "./types";
import type { PlatformMessage } from "./types";
import { SYNTHETIC_SENDER_TYPE, SYNTHETIC_CONTACT_EVENTS_SENDER_ID } from "./types";
import type { ParticipantRecord, MetadataMap } from "../contracts/dtos";
import { RuntimeStateError, ValidationError } from "../core/errors";
import { DefaultPreprocessor } from "./preprocessing/DefaultPreprocessor";
import { ContactEventHandler } from "./ContactEventHandler";
import type { ExecutionContext, ExecutionContextOptions } from "./ExecutionContext";
import type { Logger } from "../core/logger";
import { NoopLogger } from "../core/logger";

export interface PlatformRuntimeOptions {
  agentId: string;
  apiKey: string;
  wsUrl?: string;
  restUrl?: string;
  link?: ThenvoiLink;
  linkOptions?: Omit<ThenvoiLinkOptions, "agentId" | "apiKey">;
  preprocessor?: Preprocessor<PlatformEvent>;
  sessionConfig?: SessionConfig;
  contactConfig?: ContactEventConfig;
  agentConfig?: AgentConfig;
  logger?: Logger;
  onParticipantAdded?: (roomId: string, participant: ParticipantRecord) => Promise<void> | void;
  onParticipantRemoved?: (roomId: string, participantId: string) => Promise<void> | void;
  roomFilter?: (room: MetadataMap) => boolean;
  contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;
  identity?: {
    name: string;
    description?: string | null;
  };
}

export class PlatformRuntime {
  private readonly _agentId: string;
  private readonly _apiKey: string;
  private readonly _wsUrl?: string;
  private readonly _restUrl?: string;
  private readonly preprocessor: Preprocessor<PlatformEvent>;
  private readonly sessionConfig?: SessionConfig;
  private readonly contactConfig?: ContactEventConfig;
  private readonly agentConfig?: AgentConfig;
  private readonly linkOptions?: Omit<ThenvoiLinkOptions, "agentId" | "apiKey">;
  private readonly configuredIdentity?: {
    name: string;
    description?: string | null;
  };
  private readonly logger: Logger;
  private readonly _onParticipantAdded?: (roomId: string, participant: ParticipantRecord) => Promise<void> | void;
  private readonly _onParticipantRemoved?: (roomId: string, participantId: string) => Promise<void> | void;
  private readonly _roomFilter?: (room: MetadataMap) => boolean;
  private readonly _contextFactory?: (roomId: string, defaults: ExecutionContextOptions) => ExecutionContext;

  private linkInstance?: ThenvoiLink;
  private initPromise: Promise<void> | null = null;
  private runtime?: AgentRuntime;
  private contactHandler?: ContactEventHandler;
  private activeAdapter?: FrameworkAdapter;
  private stopping = false;
  private _agentName = "";
  private _agentDescription = "";
  private contactsSubscribed = false;

  public constructor(options: PlatformRuntimeOptions) {
    if (!options.agentId || options.agentId.trim() === "") {
      throw new ValidationError(
        "agentId is required and must be a non-empty string. Use loadAgentConfig() to load credentials from agent_config.yaml.",
      );
    }

    if (!options.apiKey || options.apiKey.trim() === "") {
      throw new ValidationError(
        "apiKey is required and must be a non-empty string. Use loadAgentConfig() to load credentials from agent_config.yaml.",
      );
    }

    this._agentId = options.agentId;
    this._apiKey = options.apiKey;
    this._wsUrl = options.wsUrl;
    this._restUrl = options.restUrl;
    this.linkInstance = options.link;
    this.linkOptions = options.linkOptions;
    this.preprocessor = options.preprocessor ?? new DefaultPreprocessor();
    this.sessionConfig = options.sessionConfig;
    this.contactConfig = options.contactConfig;
    this.agentConfig = options.agentConfig;
    this.logger = options.logger ?? new NoopLogger();
    this.configuredIdentity = options.identity;
    this._onParticipantAdded = options.onParticipantAdded;
    this._onParticipantRemoved = options.onParticipantRemoved;
    this._roomFilter = options.roomFilter;
    this._contextFactory = options.contextFactory;
  }

  public get link(): ThenvoiLink {
    if (!this.linkInstance) {
      throw new RuntimeStateError("Runtime is not initialized");
    }

    return this.linkInstance;
  }

  public get name(): string {
    return this._agentName;
  }

  public get agentId(): string {
    return this._agentId;
  }

  public get description(): string {
    return this._agentDescription;
  }

  public get contactConfiguration(): ContactEventConfig | undefined {
    return this.contactConfig;
  }

  public get isContactsSubscribed(): boolean {
    return this.contactsSubscribed;
  }

  public async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  private async doInitialize(): Promise<void> {
    if (!this.linkInstance) {
      this.linkInstance = new ThenvoiLink({
        ...this.linkOptions,
        agentId: this._agentId,
        apiKey: this._apiKey,
        wsUrl: this._wsUrl,
        restUrl: this._restUrl,
        logger: this.logger,
      });
    }

    if (this.configuredIdentity) {
      this._agentName = this.configuredIdentity.name;
      this._agentDescription = this.configuredIdentity.description ?? "";
      return;
    }

    const me = await this.link.rest.getAgentMe();
    this._agentName = me.name;
    this._agentDescription = me.description ?? "";
  }

  public async start(adapter: FrameworkAdapter): Promise<void> {
    await this.initialize();
    await adapter.onStarted(this._agentName, this._agentDescription);
    this.activeAdapter = adapter;

    try {
      this.contactHandler = new ContactEventHandler({
        config: this.contactConfig ?? { strategy: "disabled" },
        rest: this.link.rest,
        onBroadcast: (message) => {
          const runtime = this.runtime;
          if (!runtime) return;
          for (const context of runtime.getContexts()) {
            context.injectSystemMessage(message);
          }
        },
        onHubEvent: async (roomId, event) => {
          const runtime = this.runtime;
          if (!runtime) return;
          await runtime.enqueueEvent(roomId, event);
        },
        onHubInit: async (roomId, systemPrompt) => {
          const runtime = this.runtime;
          if (!runtime) return;
          runtime.getOrCreateContext(roomId).injectSystemMessage(systemPrompt);
        },
      });

      this.runtime = new AgentRuntime({
        link: this.link,
        agentId: this._agentId,
        sessionConfig: this.sessionConfig,
        agentConfig: this.agentConfig,
        logger: this.logger,
        onExecute: (context, event) => this.executeAdapter(context, event, adapter),
        onSessionCleanup: (roomId) => adapter.onCleanup(roomId),
        onContactEvent: (event) => this.handleContactEvent(event),
        onParticipantAdded: this._onParticipantAdded,
        onParticipantRemoved: this._onParticipantRemoved,
        roomFilter: this._roomFilter,
        contextFactory: this._contextFactory,
      });

      await this.runtime.start();
      this.contactsSubscribed = Boolean(this.link.capabilities.contacts);
    } catch (error) {
      try {
        await this.stop();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "PlatformRuntime failed to start and cleanup also failed",
        );
      }
      throw error;
    }
  }

  public async stop(timeoutMs?: number): Promise<boolean> {
    if (this.stopping) {
      return true;
    }

    const runtime = this.runtime;
    const adapter = this.activeAdapter;
    if (!runtime && !adapter) {
      return true;
    }

    this.stopping = true;
    this.runtime = undefined;
    this.contactHandler = undefined;
    this.contactsSubscribed = false;
    this.activeAdapter = undefined;

    let graceful = true;
    let runtimeError: unknown = null;

    if (runtime) {
      try {
        graceful = await runtime.stop(timeoutMs);
      } catch (error) {
        runtimeError = error;
      }
    }

    try {
      await adapter?.onRuntimeStop?.();
    } catch (error) {
      if (runtimeError) {
        throw new AggregateError(
          [runtimeError, error],
          "PlatformRuntime stop failed and adapter cleanup also failed",
        );
      }
      throw error;
    }

    if (runtimeError) {
      throw runtimeError instanceof Error ? runtimeError : new Error(String(runtimeError));
    }

    this.stopping = false;
    return graceful;
  }

  public async runForever(): Promise<void> {
    if (!this.runtime) {
      throw new RuntimeStateError("Runtime not started");
    }

    await this.runtime.waitUntilStopped();
  }

  public async bootstrapRoomMessage(roomId: string, message: PlatformMessage): Promise<void> {
    if (!this.runtime) {
      throw new RuntimeStateError("Runtime not started");
    }

    await this.runtime.bootstrapRoomMessage(roomId, message);
  }

  public async resetRoomSession(roomId: string, timeoutMs?: number): Promise<boolean> {
    if (!this.runtime) {
      throw new RuntimeStateError("Runtime not started");
    }

    return await this.runtime.resetRoomSession(roomId, timeoutMs);
  }

  private async executeAdapter(
    context: ExecutionContext,
    event: PlatformEvent,
    adapter: FrameworkAdapter,
  ): Promise<void> {
    const input = await this.preprocessor.process(context, event, this._agentId);
    if (!input) {
      return;
    }

    const messageId = String(input.message.id ?? "");
    const roomId = input.roomId;
    const isSynthetic = input.message.senderType === SYNTHETIC_SENDER_TYPE
      && input.message.senderId === SYNTHETIC_CONTACT_EVENTS_SENDER_ID;
    const messageMarkOptions = { bestEffort: true } as const;

    if (messageId && !isSynthetic) {
      await this.link.markProcessing(roomId, messageId, messageMarkOptions);
    }

    try {
      await adapter.onEvent(input);
      if (messageId && !isSynthetic) {
        await this.link.markProcessed(roomId, messageId, messageMarkOptions);
      }
    } catch (error) {
      const label = error instanceof Error ? error.message : String(error);
      if (messageId && !isSynthetic) {
        await this.link.markFailed(roomId, messageId, label, messageMarkOptions);
      }
      throw error;
    }
  }

  private async handleContactEvent(event: ContactEvent): Promise<void> {
    if (this.contactHandler) {
      await this.contactHandler.handle(event);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled contact event: ${JSON.stringify(value)}`);
}
