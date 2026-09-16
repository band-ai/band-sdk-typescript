import { Channel, Socket } from "phoenix";
import { TransportError } from "../../core/errors";
import type { Logger } from "../../core/logger";
import { KeyedSingleFlight } from "../../core/singleFlight";
import { Epoch } from "../../core/epoch";
import type { TopicHandlers } from "./transport";

interface TrackedChannel {
  channel: Channel;
  refs: Array<[string, number]>;
}

/**
 * Everything a caller needs to decide *how* a joined topic's events and
 * settlements are handled, kept out of the registry itself so it stays a
 * pure Phoenix Channel lifecycle manager with no reconnect-buffering or
 * generation-tracking policy of its own.
 */
export interface ChannelRegistryHooks {
  /**
   * Wraps a raw payload handler for `topic`/`event` with whatever delivery
   * policy the caller wants (e.g. buffering during a reconnect window) and
   * error containment. Called once per handler when a join starts.
   */
  wrapHandler(
    topic: string,
    event: string,
    handler: (payload: Record<string, unknown>) => Promise<void> | void,
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
  private readonly pendingChannels = new Map<string, TrackedChannel>();
  private readonly joinFlights = new KeyedSingleFlight<void>();
  private readonly leaveFlights = new KeyedSingleFlight<void>();

  public constructor(
    private readonly socket: Socket,
    private readonly epoch: Epoch,
    private readonly logger: Logger,
    private readonly hooks: ChannelRegistryHooks,
  ) {}

  public topics(): IterableIterator<string> {
    return this.channels.keys();
  }

  public isJoined(topic: string): boolean {
    return this.channels.has(topic);
  }

  /**
   * A promise for `topic` if it's already joined or has a join in flight,
   * without starting a new one. A topic mid-leave is never reported as
   * already joined — `channels` still holds it until the leave's Push
   * settles, but its handlers are already unbound and the channel is about
   * to be removed, so treating that window as "joined" would hand the
   * caller a promise that resolves into a channel already gone.
   */
  public existingJoin(topic: string): Promise<void> | undefined {
    if (this.channels.has(topic) && !this.leaveFlights.current(topic)) {
      return Promise.resolve();
    }
    return this.joinFlights.current(topic) ?? undefined;
  }

  /**
   * Starts a new join for `topic`. Callers check `existingJoin()` first.
   * Waits out a leave already in flight for the same topic before starting,
   * so the new join's channel is never raced by the old one's teardown.
   */
  public async join(topic: string, handlers: TopicHandlers): Promise<void> {
    const pendingLeave = this.leaveFlights.current(topic);
    if (pendingLeave) {
      await pendingLeave.catch(() => undefined);
    }
    return this.joinFlights.run(topic, () => this.doJoin(topic, handlers));
  }

  private async doJoin(topic: string, handlers: TopicHandlers): Promise<void> {
    const epoch = this.epoch.current;
    const channel = this.socket.channel(topic, {});

    const refs: Array<[string, number]> = [];
    for (const [event, handler] of Object.entries(handlers)) {
      const ref = channel.on(event, this.hooks.wrapHandler(topic, event, handler));
      refs.push([event, ref]);
    }

    this.pendingChannels.set(topic, { channel, refs });

    // Phoenix creates exactly one join `Push` per channel and reuses it for
    // every automatic rejoin (`resend()`), so hooks registered on it now stay
    // attached and fire again on every later settlement — this is the only
    // hook into a channel's reconnect outcome the public API exposes.
    const joinPush = channel.join();
    try {
      await new Promise<void>((resolve, reject) => {
        joinPush
          .receive("ok", () => {
            this.hooks.onJoinSettled(topic, true);
            resolve();
          })
          .receive("error", (error: unknown) => {
            this.hooks.onJoinSettled(topic, false);
            reject(new TransportError(`Failed to join topic ${topic}`, error));
          })
          .receive("timeout", () => {
            this.hooks.onJoinSettled(topic, false);
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
      if (this.forgetPendingChannel(topic, channel)) {
        this.abandonChannel(channel, refs);
      }
      throw error;
    }

    const stillPending = this.forgetPendingChannel(topic, channel);
    if (!stillPending || this.epoch.isStale(epoch)) {
      if (stillPending) {
        this.abandonChannel(channel, refs);
      }
      throw supersededJoinError(topic);
    }

    this.channels.set(topic, { channel, refs });
    this.logger.debug("Joined topic", { topic });
  }

  /**
   * Removes `topic`'s pendingChannels entry only if it still points at
   * `channel`, returning whether it did. A topic-keyed delete without this
   * identity check can drop a *different*, still-genuinely-pending join for
   * the same topic — reachable because a teardown clears `joinFlights`, so a
   * later join for a topic whose earlier join is still unsettled is
   * possible, and that earlier join's eventual (stale) settlement must not
   * touch a slot it no longer owns.
   */
  private forgetPendingChannel(topic: string, channel: Channel): boolean {
    if (this.pendingChannels.get(topic)?.channel !== channel) {
      return false;
    }
    this.pendingChannels.delete(topic);
    return true;
  }

  private abandonChannel(channel: Channel, refs: Array<[string, number]>): void {
    for (const [event, ref] of refs) {
      channel.off(event, ref);
    }
    channel.leave();
    removeSocketChannel(this.socket, channel);
  }

  public async leave(topic: string): Promise<void> {
    const pendingLeave = this.leaveFlights.current(topic);
    if (pendingLeave) {
      return pendingLeave;
    }

    const tracked = this.channels.get(topic);
    if (!tracked) {
      return;
    }

    return this.leaveFlights.run(topic, () => this.doLeave(topic, tracked));
  }

  private async doLeave(topic: string, tracked: TrackedChannel): Promise<void> {
    const { channel, refs } = tracked;
    for (const [event, ref] of refs) {
      channel.off(event, ref);
    }

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

    this.channels.delete(topic);
    this.hooks.onLeft(topic);
    this.logger.debug("Left topic", { topic });
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

    for (const { channel, refs } of this.pendingChannels.values()) {
      this.abandonChannel(channel, refs);
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
