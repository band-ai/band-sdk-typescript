import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, ListToolsRequest, MessageExtraInfo, RequestId } from "@modelcontextprotocol/sdk/types.js";

import { createDeferred } from "../core/deferred";
import { ForwardingTransport } from "./forwardingTransport";

const TOOLS_LIST: ListToolsRequest["method"] = "tools/list";

/**
 * Passes every message through and settles `toolsListed` once the response to the
 * client's first `tools/list` is sent; the MCP SDK has no hook for that moment.
 */
export class ToolsListedTransport extends ForwardingTransport {
  private readonly listed = createDeferred();
  public readonly toolsListed = this.listed.promise;
  private toolsListRequestId: RequestId | undefined;

  public constructor(inner: Transport) {
    super(inner);
  }

  protected override receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (this.toolsListRequestId === undefined && "method" in message && message.method === TOOLS_LIST && "id" in message) {
      this.toolsListRequestId = message.id;
    }
    super.receive(message, extra);
  }

  public override async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await super.send(message, options);
    // The server's own requests share the id range, so only a response (no `method`) counts.
    if (this.toolsListRequestId !== undefined && !("method" in message) && "id" in message && message.id === this.toolsListRequestId) {
      this.listed.resolve();
    }
  }
}
