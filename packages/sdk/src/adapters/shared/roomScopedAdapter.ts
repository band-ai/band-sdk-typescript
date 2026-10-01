import type { HistoryConverter, MessagingTools, PlatformMessageLike } from "../../contracts/protocols";
import { resolveLogger, type Logger } from "../../core/logger";
import { reportProviderTurnFailure } from "../../core/providerFailure";
import { SimpleAdapter } from "../../core/simpleAdapter";
import { asErrorMessage } from "./coercion";
import { RoomWorkspaces, type RoomWorkspaceOptions } from "./roomWorkspace";

const ADAPTER_STOPPED_ERROR = "Adapter is stopped; start it again before sending messages";

/** One room's adapter: owns that room's agent process and nothing shared. */
export type RoomEngine<H, TTools> = SimpleAdapter<H, TTools> & { onRuntimeStop(): Promise<void> };

export interface RoomScopedAdapterOptions<H> extends RoomWorkspaceOptions {
  historyConverter?: HistoryConverter<H>;
  logger?: Logger;
}

interface RoomEntry<E> {
  engine: E;
  ready: Promise<void>;
}

/**
 * Public adapter that gives every room its own engine, created on the room's
 * first message with the room's own workspace, and stopped when the room
 * leaves. Rooms share nothing, so one room's failure cannot reach another.
 */
export abstract class RoomScopedAdapter<H, TTools extends MessagingTools, E extends RoomEngine<H, TTools>>
  extends SimpleAdapter<H, TTools>
{
  private readonly roomLogger: Logger;
  private readonly workspaces: RoomWorkspaces;
  private readonly rooms = new Map<string, RoomEntry<E>>();
  // A room that rejoins while its old engine is still closing waits on this.
  private readonly closing = new Map<string, Promise<void>>();
  private stopped = false;

  protected constructor(options: RoomScopedAdapterOptions<H>) {
    super({ historyConverter: options.historyConverter });
    this.roomLogger = resolveLogger(options.logger);
    this.workspaces = new RoomWorkspaces(options);
  }

  /** Builds the engine for one room; `workspace` is its claimed real path. */
  protected abstract createRoom(roomId: string, workspace: string): E;

  public override async onStarted(agentName: string, agentDescription: string): Promise<void> {
    await super.onStarted(agentName, agentDescription);
    this.stopped = false;
  }

  public async onMessage(
    message: PlatformMessageLike,
    tools: TTools,
    history: H,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    let engine: E;
    try {
      engine = await this.engineFor(context.roomId);
    } catch (error) {
      // Reported as a turn failure: a plain throw here would stop the whole runtime.
      return reportProviderTurnFailure(tools, this.roomLogger, this.provider, "room_scoped_adapter.room_unavailable", error, {
        roomId: context.roomId,
      });
    }
    await engine.onMessage(message, tools, history, participantsMessage, contactsMessage, context);
  }

  /** Stops the room's engine without waiting for its process to exit. */
  public override async onCleanup(roomId: string): Promise<void> {
    this.retireRoom(roomId, async (engine) => {
      await engine.onCleanup(roomId);
      await engine.onRuntimeStop();
    });
  }

  public async onRuntimeStop(): Promise<void> {
    await this.stop();
  }

  /** Stops every room's engine at once and waits for all of them. */
  public async stop(): Promise<void> {
    this.stopped = true;
    for (const roomId of [...this.rooms.keys()]) {
      this.retireRoom(roomId, (engine) => engine.onRuntimeStop());
    }
    await Promise.all(this.closing.values());
  }

  private retireRoom(roomId: string, close: (engine: E) => Promise<void>): void {
    const entry = this.rooms.get(roomId);
    if (!entry) {
      return;
    }
    this.rooms.delete(roomId);
    const closed: Promise<void> = this.closeRoom(roomId, entry, close).finally(() => {
      if (this.closing.get(roomId) === closed) {
        this.closing.delete(roomId);
      }
      // A rejoined room already holds this claim again.
      if (!this.rooms.has(roomId)) {
        this.workspaces.release(roomId);
      }
    });
    this.closing.set(roomId, closed);
  }

  // Synchronous up to the returned promise, so two concurrent first turns in
  // one room cannot build two engines.
  private engineFor(roomId: string): Promise<E> {
    if (this.stopped) {
      return Promise.reject(new Error(ADAPTER_STOPPED_ERROR));
    }
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing.ready.then(() => existing.engine);
    }
    const workspace = this.workspaces.claim(roomId);
    let engine: E;
    try {
      engine = this.createRoom(roomId, workspace);
    } catch (error) {
      this.workspaces.release(roomId);
      throw error;
    }
    const entry: RoomEntry<E> = { engine, ready: this.startRoom(roomId, engine) };
    this.rooms.set(roomId, entry);
    // A room that failed to start is dropped, so its next message tries again.
    entry.ready.catch(() => {
      if (this.rooms.get(roomId) === entry) {
        void this.onCleanup(roomId);
      }
    });
    return entry.ready.then(() => engine);
  }

  private async startRoom(roomId: string, engine: E): Promise<void> {
    await this.closing.get(roomId);
    await engine.onStarted(this.agentName, this.agentDescription);
  }

  // Never rejects: a failure is logged, so shutdown and rejoin always proceed.
  private async closeRoom(roomId: string, { engine, ready }: RoomEntry<E>, close: (engine: E) => Promise<void>): Promise<void> {
    await ready.catch(() => undefined);
    try {
      await close(engine);
    } catch (error) {
      this.roomLogger.warn("room_scoped_adapter.room_close_failed", { roomId, error: asErrorMessage(error) });
    }
  }
}
