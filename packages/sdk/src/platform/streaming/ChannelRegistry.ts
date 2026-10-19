import { Channel, Socket } from "phoenix";
import { TransportError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { KeyedSingleFlight } from "../../core/singleFlight";
import { Epoch } from "../../core/epoch";
import { isOptionalTopic, type JoinOptions, type TopicHandlers } from "./transport";

interface TrackedChannel {
  channel: Channel;
  refs: Array<[string, number]>;
  options: JoinOptions;
}

interface PendingJoin extends TrackedChannel {
  /**
   * Rejects `doJoin()`'s awaited join outcome directly. Needed because once
   * a join is abandoned (channel.leave() + removed from the socket), real
   * Phoenix cancels the join Push's timeout timer and makes its reply
   * unroutable — so an abandoned join can never settle on its own, and
   * without this, `doJoin()`'s awaiter would hang forever. Calling it after
   * the join already settled naturally is a harmless no-op.
   */
  reject: (error: Error) => void;
}

/**
 * Everything a caller needs to decide *how* a joined topic's events and
 * settlements are handled, kept out of the registry itself so it stays a
 * pure Phoenix Channel lifecycle manager with no reconnect-buffering or
 * generation-tracking policy of its own.
 */
export interface ChannelRegistryHooks {
  /**
   * Adapts a raw payload handler for `topic`/`event` into the sync,
   * void-returning callback Phoenix's `Channel.on` requires, applying
   * whatever delivery policy the caller wants (e.g. buffering during a
   * reconnect window) and error containment along the way. Called once per
   * handler when a join starts.
   */
  wrapHandler(
    topic: string,
    event: string,
    handler: (payload: Record<string, unknown>) => Promise<void> | void,
    options: JoinOptions,
  ): (payload: Record<string, unknown>) => void;
  /**
   * Called every time a topic's join Push settles — not just once: Phoenix
   * reuses one Push per channel and resends it on every automatic rejoin, so
   * this can fire again long after the join() call that created it returned.
   */
  onJoinSettled(topic: string, joined: boolean): void;
  /** Called once a topic has fully and successfully left. */
  onLeft(topic: string): void;
}

export function supersededJoinError(topic: string): TransportError {
  return new TransportError(`Join superseded by transport disconnect for topic ${topic}`);
}

/**
 * Owns the lifecycle of every Phoenix `Channel` this transport holds: join
 * and leave coalescing (concurrent calls for the same topic share one
 * physical operation), and tracking a join from the moment its Channel is
 * created — before its join Push settles — so a teardown mid-join can still
 * find and detach it. What happens with a topic's delivered events or a
 * join's settlement outcome is entirely up to the injected hooks.
 */
export class ChannelRegistry {
  private readonly channels = new Map<string, TrackedChannel>();
  // A join's Channel and handler bindings, tracked from the moment doJoin
  // creates them — before the join Push settles — so a teardown mid-join can
  // find and detach it too, not only joins already promoted into `channels`.
  // Left untracked here, the underlying Phoenix Channel would survive
  // teardown unnoticed, keep its handlers bound, and could later be
  // resurrected by Phoenix's own reconnect machinery, redelivering live
  // events with no dedup anywhere upstream.
  private readonly pendingChannels = new Map<string, PendingJoin>();
  private readonly joinFlights = new KeyedSingleFlight<void>();
  private readonly leaveFlights = new KeyedSingleFlight<void>();

  public constructor(
    private readonly socket: Socket,
    private readonly epoch: Epoch,
    private readonly logger: Logger,
    private readonly hooks: ChannelRegistryHooks,
  ) {}

  /** The joined topics a reconnect waits on; optional topics (`blocksReconnect: false`) are left out. */
  public *topics(): IterableIterator<string> {
    for (const [topic, tracked] of this.channels) {
      if (!isOptionalTopic(tracked.options)) yield topic;
    }
  }

  /** Reports every owned channel, pending joins included, as lost. A transport disconnect uses it to invalidate before the close handshake finishes. */
  public notifyUnavailable(): void {
    for (const [topic, tracked] of [...this.channels, ...this.pendingChannels]) {
      this.notifyLost(topic, tracked.options);
    }
  }

  /** Whether `channel` is the pending or joined channel for `topic`, and not already on its way out. */
  private owns(topic: string, channel: Channel): boolean {
    return (
      this.pendingChannels.get(topic)?.channel === channel ||
      (this.channels.get(topic)?.channel === channel && !this.leaveFlights.current(topic))
    );
  }

  private notifyLost(topic: string, options: JoinOptions): void {
    this.observe(topic, "onUnavailable", () => options.onUnavailable?.());
  }

  /**
   * Runs a feature callback, containing a throw or a rejection so it never
   * reaches Phoenix or the registry. Only the error's name is logged: its
   * message can carry the caller's data.
   */
  private observe(topic: string, callback: "onJoined" | "onUnavailable", run: () => void): void {
    const failed = (error: unknown): void =>
      this.logger.error("Topic lifecycle observer failed", {
        topic,
        callback,
        error: error instanceof Error ? error.name : typeof error,
      });
    try {
      void Promise.resolve(run()).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /**
   * Whether `topic` is joined and not on its way out: `channels` still holds
   * a topic mid-leave until the leave's Push settles, though its handlers are
   * already unbound.
   */
  public isJoined(topic: string): boolean {
    return this.channels.has(topic) && !this.leaveFlights.current(topic);
  }

  /**
   * A promise for `topic` if it's already joined or has a join in flight,
   * without starting a new one. A topic mid-leave is never reported as
   * already joined (see `isJoined`): treating that window as "joined" would
   * hand the caller a promise that resolves into a channel already gone.
   */
  public existingJoin(topic: string): Promise<void> | undefined {
    if (this.isJoined(topic)) {
      return Promise.resolve();
    }
    return this.joinFlights.current(topic) ?? undefined;
  }

  /**
   * Starts a new join for `topic`. Callers check `existingJoin()` first.
   * Waits out a leave already in flight for the same topic before starting,
   * so the new join's channel is never raced by the old one's teardown.
   */
  public async join(topic: string, handlers: TopicHandlers, options: JoinOptions = {}): Promise<void> {
    const pendingLeave = this.leaveFlights.current(topic);
    if (pendingLeave) {
      await pendingLeave.catch(() => undefined);
    }
    return this.joinFlights.run(topic, () => this.doJoin(topic, handlers, options));
  }

  private async doJoin(topic: string, handlers: TopicHandlers, options: JoinOptions): Promise<void> {
    const epoch = this.epoch.current;
    const channel = this.socket.channel(topic, {});

    const current = (): boolean => !this.epoch.isStale(epoch) && this.owns(topic, channel);
    const unavailable = (): void => {
      if (current()) this.notifyLost(topic, options);
    };
    const refs: Array<[string, number]> = [
      ["phx_error", channel.on("phx_error", unavailable)],
      ["phx_close", channel.on("phx_close", unavailable)],
    ];
    for (const [event, handler] of Object.entries(handlers)) {
      const ref = channel.on(event, this.hooks.wrapHandler(topic, event, (payload) => {
        if (current()) return handler(payload);
      }, options));
      refs.push([event, ref]);
    }

    // Phoenix creates exactly one join `Push` per channel and reuses it for
    // every automatic rejoin (`resend()`), so hooks registered on it now stay
    // attached and fire again on every later settlement — this is the only
    // hook into a channel's reconnect outcome the public API exposes.
    const joinPush = channel.join();
    try {
      await new Promise<void>((resolve, reject) => {
        this.pendingChannels.set(topic, { channel, refs, options, reject });
        joinPush
          .receive("ok", (reply: unknown) => {
            if (!current()) return;
            this.observe(topic, "onJoined", () => options.onJoined?.(reply));
            this.settleJoin(topic, "ok");
            resolve();
          })
          .receive("error", (error: unknown) => {
            if (!current()) return;
            unavailable();
            this.settleJoin(topic, "error");
            reject(new TransportError(`Failed to join topic ${topic}`, error));
          })
          .receive("timeout", () => {
            if (!current()) return;
            unavailable();
            this.settleJoin(topic, "timeout");
            reject(new TransportError(`Timeout joining topic ${topic}`));
          });
      });
    } catch (error) {
      // Leave and remove the channel so it doesn't get rejoined on reconnect
      // — but only if this join still owns the pendingChannels entry for
      // this topic. A teardown may have already abandoned it (clearing the
      // entry first), or a later join for the same topic may have already
      // taken the slot (teardown also clears `joinFlights`); either way this
      // settlement must not touch state that isn't its own.
      const pending = this.forgetPendingChannel(topic, channel);
      if (pending) {
        this.abandonChannel(topic, pending);
      }
      throw error;
    }

    const pending = this.forgetPendingChannel(topic, channel);
    if (!pending || this.epoch.isStale(epoch)) {
      if (pending) {
        this.abandonChannel(topic, pending);
      }
      this.logger.debug("Join superseded by transport disconnect/reconnect", { topic });
      throw supersededJoinError(topic);
    }

    this.channels.set(topic, { channel, refs, options });
    this.logger.debug("Joined topic", { topic });
  }

  /** Runs on every settlement of the join Push, automatic rejoins included. */
  private settleJoin(topic: string, outcome: "ok" | "error" | "timeout"): void {
    this.logger.debug("Join settled", { topic, outcome });
    this.hooks.onJoinSettled(topic, outcome === "ok");
  }

  /**
   * Removes and returns `topic`'s pendingChannels entry only if it still
   * points at `channel`. A topic-keyed delete without this identity check
   * can drop a *different*, still-genuinely-pending join for the same topic
   * — reachable because a teardown clears `joinFlights`, so a later join for
   * a topic whose earlier join is still unsettled is possible, and that
   * earlier join's eventual (stale) settlement must not touch a slot it no
   * longer owns.
   */
  private forgetPendingChannel(topic: string, channel: Channel): PendingJoin | undefined {
    const pending = this.pendingChannels.get(topic);
    if (pending?.channel !== channel) {
      return undefined;
    }
    this.pendingChannels.delete(topic);
    return pending;
  }

  /**
   * Detaches a join's channel and — via `pending.reject` — settles its
   * still-outstanding join promise directly, so abandoning it can never
   * leave `doJoin()`'s awaiter hanging on a Phoenix reply that a `leave()`
   * just made unroutable.
   */
  private abandonChannel(topic: string, pending: PendingJoin): void {
    for (const [event, ref] of pending.refs) {
      pending.channel.off(event, ref);
    }
    pending.channel.leave();
    removeSocketChannel(this.socket, pending.channel);
    pending.reject(supersededJoinError(topic));
  }

  public async leave(topic: string): Promise<void> {
    const pendingLeave = this.leaveFlights.current(topic);
    if (pendingLeave) {
      return pendingLeave;
    }

    const pending = this.pendingChannels.get(topic);
    if (pending && isOptionalTopic(pending.options)) {
      return this.leavePending(topic, pending);
    }
    const tracked = this.channels.get(topic);
    if (!tracked) {
      return;
    }

    return this.leaveFlights.run(topic, () => this.doLeave(topic, tracked));
  }

  /** Abandons an optional join still in flight; a mandatory join is left to settle so reconnect recovery still awaits it. */
  private async leavePending(topic: string, pending: PendingJoin): Promise<void> {
    this.notifyLost(topic, pending.options);
    this.pendingChannels.delete(topic);
    this.abandonChannel(topic, pending);
    await this.joinFlights.current(topic)?.catch(() => undefined);
    this.hooks.onLeft(topic);
  }

  private async doLeave(topic: string, tracked: TrackedChannel): Promise<void> {
    const { channel, refs, options } = tracked;
    this.notifyLost(topic, options);
    for (const [event, ref] of refs) {
      channel.off(event, ref);
    }

    try {
      await new Promise<void>((resolve, reject) => {
        channel
          .leave()
          .receive("ok", () => resolve())
          .receive("error", (error: unknown) =>
            reject(new TransportError(`Failed to leave topic ${topic}`, error)),
          )
          .receive("timeout", () =>
            reject(new TransportError(`Timeout leaving topic ${topic}`)),
          );
      });
    } catch (error) {
      // An optional channel is never left registered behind a failed leave,
      // or a same-topic restart would mistake it for a usable join.
      if (isOptionalTopic(options)) {
        removeSocketChannel(this.socket, channel);
        this.forget(topic, tracked);
      }
      throw error;
    }

    this.forget(topic, tracked);
    this.logger.debug("Left topic", { topic });
  }

  /** Drops `topic`'s entry, but only while it still identifies `tracked`. */
  private forget(topic: string, tracked: TrackedChannel): void {
    if (this.channels.get(topic) === tracked) {
      this.channels.delete(topic);
      this.hooks.onLeft(topic);
    }
  }

  /**
   * Attempts a graceful leave for every currently joined topic. A leave that
   * fails leaves its channel registered until `forceTeardown()` sweeps it.
   * Returns the rejection reasons of any leaves that failed.
   */
  public async leaveAll(): Promise<unknown[]> {
    const topics = [...this.channels.keys()];
    const results = await Promise.allSettled(topics.map((topic) => this.leave(topic)));
    return results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result): unknown => result.reason);
  }

  /**
   * Forcibly detaches anything still registered — a leave that failed above,
   * or a join still in flight — and clears all coalescing state. Call after
   * `leaveAll()` has settled.
   */
  public forceTeardown(): void {
    for (const { channel, refs } of this.channels.values()) {
      for (const [event, ref] of refs) {
        channel.off(event, ref);
      }
      removeSocketChannel(this.socket, channel);
    }
    this.channels.clear();

    for (const [topic, pending] of this.pendingChannels) {
      this.abandonChannel(topic, pending);
    }
    this.pendingChannels.clear();

    this.joinFlights.clear();
    this.leaveFlights.clear();
  }
}

function removeSocketChannel(socket: Socket, channel: Channel): void {
  const candidate = socket as unknown as { remove?: (value: Channel) => void };
  candidate.remove?.(channel);
}
