import type { WebSocketDisconnectError, WebSocketDisconnectReason } from "./disconnectReason";

export interface TopicHandlers {
  [event: string]: (payload: Record<string, unknown>) => Promise<void> | void;
}

export interface JoinOptions {
  /** Called synchronously with the raw join reply, on the first join and on every automatic rejoin. */
  onJoined?: (reply: unknown) => void;
  /** Called synchronously when the channel is lost, errored, closed or left. May repeat for one loss. */
  onUnavailable?: () => void;
  /**
   * `false` makes the topic optional: its join does not wait on the reconnect
   * barrier, it is left out of the reconnect snapshot, and leaving it while
   * its join is in flight abandons that join. Defaults to `true`.
   */
  blocksReconnect?: boolean;
  /**
   * Exempts this topic's event delivery from any reconnect-buffering window
   * a transport may hold events behind. Only a channel whose events must
   * never wait on reconciliation (e.g. a control channel carrying session
   * supersede notices) should set this.
   */
  exemptFromBuffering?: boolean;
}

/** Whether a topic joined with `options` is independent of mandatory recovery; `blocksReconnect` defaults to true. */
export function isOptionalTopic(options?: JoinOptions): boolean {
  return options?.blocksReconnect === false;
}

/**
 * One settled outcome of an automatic transport-level reconnect: every topic
 * the transport owned when the socket reopened has since either rejoined or
 * failed to. `attemptedTopics` fixes that generation's membership boundary;
 * `joinedTopics` is its successful subset. Carries no transport-specific
 * objects so every transport implementation can produce one.
 */
export interface ReconnectSnapshot {
  generation: number;
  attemptedTopics: ReadonlySet<string>;
  joinedTopics: ReadonlySet<string>;
}

export type ReconnectObserver = (
  snapshot: ReconnectSnapshot,
) => Promise<void> | void;

export type TopicRejoinObserver = (topic: string) => void;

export type TerminalObserver = (error: WebSocketDisconnectError) => void;

export type DropObserver = (reason: WebSocketDisconnectReason) => void;

/** Receives each raw `agent.control` payload pushed on the agent's control channel, in order. */
export type ControlObserver = (payload: Record<string, unknown>) => void;

export interface StreamingTransport {
  /**
   * Connects, rejecting if `signal` aborts first. `disconnect()` may run while
   * a connect is still in flight and should settle it.
   */
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  join(topic: string, handlers: TopicHandlers, options?: JoinOptions): Promise<void>;
  leave(topic: string): Promise<void>;
  runForever(signal: AbortSignal): Promise<void>;
  isConnected(): boolean;
  /** The latest failure: the one being retried, or why the session ended; null before any. */
  getDisconnectReason(): WebSocketDisconnectReason | null;
  /** The error the session ended with for good, or null while it can still connect. */
  getTerminalError(): WebSocketDisconnectError | null;
  /**
   * Called once when the session ends for good, including a terminal connect
   * failure, before that connect rejects. Returns an unsubscribe function.
   */
  onTerminal(observer: TerminalObserver): () => void;
  /**
   * Optional: a transport that can observe its own automatic reconnects
   * registers here. Omitted by transports (and test doubles) with no
   * reconnect story of their own, so existing injected transports stay
   * source-compatible. Returns an unsubscribe function.
   */
  onReconnected?(observer: ReconnectObserver): () => void;
  /**
   * Optional: a transport that can see a single channel rejoin on a socket
   * that never dropped (the server crashed just that channel) registers here.
   * A channel the server closes is dropped by Phoenix and never rejoins.
   * Nothing was delivered on the topic while it was gone, so an observer
   * should catch up. Called synchronously from the join's
   * settlement, ahead of any event the rejoined channel delivers, so whatever
   * it queues stays in order with them. Returns an unsubscribe function.
   */
  onTopicRejoined?(observer: TopicRejoinObserver): () => void;
  /**
   * Optional: called when a live connection drops and the transport will
   * reconnect on its own. A session that ends for good reports through
   * `onTerminal` instead. Returns an unsubscribe function.
   */
  onDropped?(observer: DropObserver): () => void;
  /**
   * Optional: a transport that joins the agent's control channel reports each
   * `agent.control` push here, synchronously and unbuffered, as it arrives.
   * Returns an unsubscribe function.
   */
  onControl?(observer: ControlObserver): () => void;
}
