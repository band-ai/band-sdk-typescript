/**
 * An agent's real Phoenix transport whose live socket a scenario can drop
 * mid-session, either as a network failure would (`terminate()`, no close
 * handshake) or with a normal close frame (1000), which earlier SDKs wrongly
 * treated as final. Either way the transport's own reconnect logic runs
 * rather than a clean disconnect's. Built only from the transport's constructor
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

/** The `ws` socket the Node transport opens; `terminate()` is its forcible close, `close()` its handshake. */
interface NodeSocket {
  terminate(): void;
  close(code: number): void;
}

/** How a scenario drops the live socket. */
export type SocketDrop = "sever" | "normal_close";

const NORMAL_CLOSURE = 1000;

type SocketConstructor = new (address: string | URL, protocols?: string | string[]) => NodeSocket;

export class DroppableTransport {
  public readonly transport: PhoenixChannelsTransport;
  /** The socket the transport opened last, the one a drop severs. */
  private live: NodeSocket | undefined;
  /** Every reconnect the transport settled, in order. */
  private readonly reconnects = new RecordLog<ReconnectSnapshot>();

  public constructor(identity: AgentIdentity, wsUrl: string) {
    const Socket = resolveWebSocketFactory(identity.apiKey) as unknown as SocketConstructor;
    const record = (socket: NodeSocket) => (this.live = socket);
    // Constructing the real socket and returning it keeps every behaviour the transport relies on.
    class RecordedSocket {
      public constructor(address: string | URL, protocols?: string | string[]) {
        return record(new Socket(address, protocols));
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

  /** Drops the live socket, and returns the reconnect the transport settles after it. */
  public async dropAndReconnect(drop: SocketDrop = "sever", timeoutMs = LIVE_EVENT_TIMEOUT_MS): Promise<ReconnectSnapshot> {
    if (!this.live) {
      throw new Error("the transport has no socket to drop; start the agent first");
    }
    const settledBefore = this.reconnects.entries.length;
    if (drop === "sever") {
      this.live.terminate();
    } else {
      this.live.close(NORMAL_CLOSURE);
    }
    const reconnect = await waitFor(this.reconnects, () => this.reconnects.entries[settledBefore], timeoutMs);
    if (!reconnect) {
      throw new Error(`the transport did not reconnect within ${timeoutMs}ms of the drop`);
    }
    return reconnect;
  }
}
