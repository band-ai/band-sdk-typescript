import { SimpleAdapter } from "../core/simpleAdapter";
import { RecoverableTurnError } from "../core/errors";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { HistoryProvider, PlatformMessage } from "../runtime/types";
import { asErrorMessage } from "./shared/coercion";
import { deliverReply } from "./shared/deliveryFailedError";
import { agentFailure, reportTurnFailure } from "./shared/providerFailure";

/**
 * The handler is arbitrary caller code with no other way to reach
 * `deliverReply` — routing its `sendMessage` calls through it here means a
 * Band-delivery rejection reaches `onMessage`'s catch as a `DeliveryFailedError`
 * (a `RecoverableTurnError`, already rethrown as-is below) instead of an
 * opaque `Error` that gets misreported as a `"generic"` provider failure.
 * Every other property is resolved against the real `tools` — as receiver,
 * not just as lookup target — so a method runs with its original `this` and
 * an accessor's getter/setter runs with its original receiver too.
 *
 * A `Proxy` whose *target* is `tools` itself doesn't work: `AgentTools.
 * buildAdapterTools()` hands adapters an `Object.freeze`d object, and a
 * `get` trap returning anything other than a frozen own property's exact
 * stored value — as the `sendMessage` override below must — violates the
 * Proxy invariant for non-configurable, non-writable data properties and
 * throws a `TypeError`. The target here is instead a fresh, ordinary,
 * unfrozen object with no properties of its own, so it imposes no such
 * invariant — every trap is free to return whatever `tools` actually holds.
 *
 * Nor does this statically enumerate `tools`' own/prototype keys and copy
 * bound functions onto a delegate: that misses methods more than one
 * prototype level up an inheritance chain (`Reflect.get` walks the *whole*
 * chain, not just the immediate prototype), misses accessor properties
 * entirely (their value is only known at access time, not enumeration
 * time), and — since a delegate's own shadowing assignment on a later call
 * would land on the delegate, not `tools` — silently drops state a called
 * method mutates on `this` for any method it did miss. Resolving every
 * property lazily through `Reflect.get(tools, key, tools)` handles methods,
 * inherited methods at any depth, and accessors uniformly, with `tools` as
 * the receiver throughout.
 */
function toolsWithDeliverySafeSendMessage(tools: AdapterToolsProtocol): AdapterToolsProtocol {
  return new Proxy({} as AdapterToolsProtocol, {
    has(_target, key) {
      return Reflect.has(tools, key);
    },
    get(_target, key) {
      if (key === "sendMessage") {
        return (content: string, mentions?: Parameters<AdapterToolsProtocol["sendMessage"]>[1]) =>
          deliverReply(tools, content, mentions);
      }
      const value: unknown = Reflect.get(tools, key, tools);
      return typeof value === "function" ? (value.bind(tools) as unknown) : value;
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
      if (error instanceof RecoverableTurnError) {
        throw error;
      }

      // Otherwise unguarded, a handler bug would escape as a plain throw:
      // `SimpleAdapter` has no catch of its own, so it isn't a
      // RecoverableTurnError and takes the whole runtime down instead of just
      // failing this turn — every other adapter in this SDK reports and fails
      // the turn instead.
      await reportTurnFailure(tools, agentFailure(this.provider, asErrorMessage(error)));
    }
  }
}
