import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

/**
 * A transport decorator that forwards the whole surface — callbacks, sends,
 * session, protocol version, cleanup — to `inner`. Decorators stack, so each
 * composes with handlers already on `inner` rather than replacing them.
 */
export abstract class ForwardingTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: Transport["onmessage"];
  /** Present only when `inner` supports it, so the framework sets it on the transport it speaks on. */
  public setProtocolVersion?: (version: string) => void;
  protected readonly inner: Transport;

  protected constructor(inner: Transport) {
    this.inner = inner;
    const innerSet = inner.setProtocolVersion;
    if (typeof innerSet === "function") {
      this.setProtocolVersion = (version) => innerSet.call(inner, version);
    }
  }

  /** `Protocol.connect` sets this transport's handlers just before calling it. */
  public start(): Promise<void> {
    this.inner.onmessage = (message, extra) => this.receive(message, extra);
    const innerClose = this.inner.onclose;
    this.inner.onclose = () => {
      innerClose?.();
      this.onclose?.();
    };
    const innerError = this.inner.onerror;
    this.inner.onerror = (error) => {
      innerError?.(error);
      this.onerror?.(error);
    };
    return this.inner.start();
  }

  /** Hands an inbound message to this transport's handler; a decorator that inspects messages overrides it. */
  protected receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    this.onmessage?.(message, extra);
  }

  public get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  public async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this.inner.send(message, options);
  }

  public close(): Promise<void> {
    return this.inner.close();
  }
}
