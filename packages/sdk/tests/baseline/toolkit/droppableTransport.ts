/**
 * An agent's real Phoenix transport whose live socket a scenario can drop
 * mid-session, as a network failure would: `terminate()` destroys the socket
 * with no close handshake, so the transport's own reconnect logic runs rather
 * than a clean disconnect's. Built only from the transport's constructor
 * options and its `onReconnected` hook, and handed to the agent through
 * `RunOptions.transport`; no private state is touched.
 */
import { DEFAULT_WS_URL } from "../../../src/platform/BandLink";
import { PhoenixChannelsTransport, resolveWebSocketFactory } from "../../../src/platform/streaming/PhoenixChannelsTransport";
import type { ReconnectSnapshot } from "../../../src/platform/streaming/transport";
import { LIVE_EVENT_TIMEOUT_MS } from "../../integration/support/liveHarness";
import { RecordLog } from "../../testUtils";
import type { AgentIdentity } from "./agents";
import { liveRun } from "./liveRun";
import { waitFor } from "./waitFor";

/** The `ws` socket the Node transport opens; `terminate()` is its forcible close. */
interface NodeSocket {
  terminate(): void;
}

type SocketConstructor = new (address: string | URL, protocols?: string | string[]) => NodeSocket;

export class DroppableTransport {
  public readonly transport: PhoenixChannelsTransport;
  /** Every socket the transport opened, the live one last. */
  private readonly sockets: NodeSocket[] = [];
  /** Every reconnect the transport settled, in order. */
  private readonly reconnects = new RecordLog<ReconnectSnapshot>();
  private reconnectsBeforeDrop = 0;

  public constructor(identity: AgentIdentity, wsUrl: string) {
    const Socket = resolveWebSocketFactory(identity.apiKey) as unknown as SocketConstructor;
    const opened = this.sockets;
    // Constructing the real socket and returning it keeps every behaviour the transport relies on.
    class RecordedSocket {
      public constructor(address: string | URL, protocols?: string | string[]) {
        const socket = new Socket(address, protocols);
        opened.push(socket);
        return socket;
      }
    }
    this.transport = new PhoenixChannelsTransport({
      wsUrl,
      apiKey: identity.apiKey,
      agentId: identity.id,
      websocketFactory: RecordedSocket as unknown as typeof WebSocket,
    });
    this.transport.onReconnected((snapshot) => this.reconnects.record(snapshot));
  }

  public static async create(identity: AgentIdentity): Promise<DroppableTransport> {
    const { env } = await liveRun();
    return new DroppableTransport(identity, env.wsUrl ?? DEFAULT_WS_URL);
  }

  /** Drops the live socket without a close handshake. */
  public drop(): void {
    const live = this.sockets.at(-1);
    if (!live) {
      throw new Error("the transport has no socket to drop; start the agent first");
    }
    this.reconnectsBeforeDrop = this.reconnects.entries.length;
    live.terminate();
  }

  /** The reconnect the transport settled after the last drop, or undefined if none did in time. */
  public untilReconnected(timeoutMs = LIVE_EVENT_TIMEOUT_MS): Promise<ReconnectSnapshot | undefined> {
    return waitFor(this.reconnects, () => this.reconnects.entries[this.reconnectsBeforeDrop], timeoutMs);
  }
}
