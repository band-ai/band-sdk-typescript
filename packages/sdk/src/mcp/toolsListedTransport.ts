import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, ListToolsRequest, RequestId } from "@modelcontextprotocol/sdk/types.js";

const TOOLS_LIST: ListToolsRequest["method"] = "tools/list";

/**
 * Passes every message through and settles `toolsListed` once a response to a
 * client's `tools/list` is first sent; the MCP SDK has no hook for that moment.
 */
export class ToolsListedTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: Transport["onmessage"];
  public readonly toolsListed: Promise<void>;
  private readonly inner: Transport;
  private resolveToolsListed!: () => void;
  // Every pending one: a cancelled request gets no response.
  private readonly toolsListRequestIds = new Set<RequestId>();

  public constructor(inner: Transport) {
    this.inner = inner;
    this.toolsListed = new Promise((resolve) => {
      this.resolveToolsListed = resolve;
    });
  }

  /** `Protocol.connect` sets this transport's handlers just before calling it. */
  public start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      if ("method" in message && message.method === TOOLS_LIST && "id" in message) {
        this.toolsListRequestIds.add(message.id);
      }
      this.onmessage?.(message, extra);
    };
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    return this.inner.start();
  }

  public async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options);
    // The server's own requests share the id range, so only a response (no `method`) counts.
    if (!("method" in message) && "id" in message && message.id !== undefined && this.toolsListRequestIds.delete(message.id)) {
      this.resolveToolsListed();
    }
  }

  public close(): Promise<void> {
    return this.inner.close();
  }
}
