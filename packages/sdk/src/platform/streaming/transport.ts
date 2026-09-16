export interface TopicHandlers {
  [event: string]: (payload: Record<string, unknown>) => Promise<void> | void;
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

export interface StreamingTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  join(topic: string, handlers: TopicHandlers): Promise<void>;
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
}
