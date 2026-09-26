import { SimpleAdapter } from "../core/simpleAdapter";
import { rethrowIfRecoverableTurnFailure } from "../core/errors";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { HistoryProvider, PlatformMessage } from "../runtime/types";
import { asErrorMessage } from "./shared/coercion";
import { deliverReply } from "../core/deliveryFailedError";
import { agentFailure, reportTurnFailure } from "../core/providerFailure";

/**
 * Route handler `sendMessage` through `deliverReply` via a Proxy over a fresh
 * empty target: `tools` is frozen, so the `sendMessage` override cannot live
 * on it. `Reflect.get(tools, key, tools)` keeps inherited accessors/methods
 * bound to the real tools instance.
 */
function toolsWithDeliverySafeSendMessage(tools: AdapterToolsProtocol): AdapterToolsProtocol {
  return new Proxy({} as AdapterToolsProtocol, {
    has(_target, key) {
      return Reflect.has(tools, key);
    },
    get(_target, key) {
      if (key === "sendMessage") {
        return (content: string, mentions?: Parameters<AdapterToolsProtocol["sendMessage"]>[1]) =>
          deliverReply(tools, content, mentions ?? []);
      }
      const value: unknown = Reflect.get(tools, key, tools);
      return typeof value === "function" ? (value.bind(tools) as unknown) : value;
    },
    // Without this, a write against the empty target would silently succeed
    // and vanish — invisible even to the handler that made it, since `get`
    // never consults the target. `tools` is frozen, so forwarding here
    // throws the same `TypeError` a write against the real, unwrapped
    // `tools` always has.
    set(_target, key, value) {
      return Reflect.set(tools, key, value, tools);
    },
    // Without these two traps, `Object.keys`/spread/`Object.assign` fall back
    // to the empty target's own keys — reporting no properties at all, even
    // though `has`/`get` resolve every one of them. `configurable: true` is
    // required, not a choice: the target has no own properties of its own, so
    // the Proxy invariants forbid reporting any key as non-configurable.
    ownKeys() {
      return Reflect.ownKeys(tools);
    },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(tools, key);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}

export type GenericAdapterHandler = (args: {
  message: PlatformMessage;
  tools: AdapterToolsProtocol;
  history: HistoryProvider;
  participantsMessage: string | null;
  contactsMessage: string | null;
  isSessionBootstrap: boolean;
  roomId: string;
  agentName: string;
  agentDescription: string;
}) => Promise<void>;

export class GenericAdapter extends SimpleAdapter<HistoryProvider> {
  protected readonly provider = "generic";

  private readonly handler: GenericAdapterHandler;

  public constructor(handler: GenericAdapterHandler) {
    super();
    this.handler = handler;
  }

  public async onMessage(
    message: PlatformMessage,
    tools: AdapterToolsProtocol,
    history: HistoryProvider,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: { isSessionBootstrap: boolean; roomId: string },
  ): Promise<void> {
    try {
      await this.handler({
        message,
        tools: toolsWithDeliverySafeSendMessage(tools),
        history,
        participantsMessage,
        contactsMessage,
        isSessionBootstrap: context.isSessionBootstrap,
        roomId: context.roomId,
        agentName: this.agentName,
        agentDescription: this.agentDescription,
      });
    } catch (error) {
      // A handler built on this SDK's own helpers (deliverReply,
      // reportTurnFailure) can legitimately throw an already-reported
      // RecoverableTurnError — rethrow it as-is rather than wrapping it in a
      // second, duplicate failure report.
      rethrowIfRecoverableTurnFailure(error);

      // Otherwise unguarded, a handler bug would escape as a plain throw:
      // `SimpleAdapter` has no catch of its own, so it isn't a
      // RecoverableTurnError and takes the whole runtime down instead of just
      // failing this turn — every other adapter in this SDK reports and fails
      // the turn instead.
      await reportTurnFailure(tools, agentFailure(this.provider, asErrorMessage(error)));
    }
  }
}
