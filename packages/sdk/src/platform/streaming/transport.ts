export interface TopicHandlers {
  [event: string]: (payload: Record<string, unknown>) => Promise<void> | void;
}

export interface JoinOptions {
  /**
   * Exempts this topic's event delivery from any reconnect-buffering window
   * a transport may hold events behind. Only a channel whose events must
   * never wait on reconciliation (e.g. a control channel carrying session
   * supersede notices) should set this.
   */
  exemptFromBuffering?: boolean;
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

export interface StreamingTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  join(topic: string, handlers: TopicHandlers, options?: JoinOptions): Promise<void>;
  leave(topic: string): Promise<void>;
  runForever(signal: AbortSignal): Promise<void>;
  isConnected(): boolean;
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
}
