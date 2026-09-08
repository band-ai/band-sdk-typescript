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
 * Every other method is forwarded bound to the real `tools`, so it runs with
 * its original receiver; every other property reads through the prototype
 * chain unchanged.
 *
 * Not a `Proxy` over `tools`: `AgentTools.buildAdapterTools()` hands adapters
 * an `Object.freeze`d object, and a `Proxy` `get` trap returning anything
 * other than a frozen own property's exact stored value — as the
 * `sendMessage` override below must — violates the Proxy invariant for
 * non-configurable, non-writable data properties and throws a `TypeError`.
 *
 * Not a bare `Object.create(tools)` delegate either: reading a forwarded
 * method off it would still work, but *calling* it runs with `this` bound to
 * the facade, not `tools` — for a class-based `AdapterToolsProtocol`
 * implementation whose methods use real (`#`) private fields, that throws
 * even for an unmodified method like `sendEvent`, since a private field is
 * inaccessible on any object other than a genuine instance of its declaring
 * class. Explicitly binding each forwarded method to `tools` keeps every
 * call's receiver the real instance regardless.
 *
 * `keys` covers both shapes a caller might have handed in without hardcoding
 * `AdapterToolsProtocol`'s member list: `tools`' own enumerable keys catch
 * `AgentTools`' frozen plain-object shape, and its prototype's own keys catch
 * a class-based implementation's methods (skipped when the prototype is the
 * default `Object.prototype`, so unrelated built-ins like `toString` aren't
 * forwarded). `Object.defineProperty`, not plain assignment, for every
 * forwarded key: assigning through a prototype chain onto a frozen own
 * property throws for the same reason a `Proxy` trap would.
 */
function toolsWithDeliverySafeSendMessage(tools: AdapterToolsProtocol): AdapterToolsProtocol {
  const facade = Object.create(tools) as AdapterToolsProtocol;

  const prototype: unknown = Object.getPrototypeOf(tools);
  const prototypeKeys = prototype && prototype !== Object.prototype
    ? Object.getOwnPropertyNames(prototype)
    : [];
  const keys = new Set([...Object.keys(tools), ...prototypeKeys]);
  keys.delete("constructor");
  for (const key of keys) {
    const value: unknown = (tools as unknown as Record<string, unknown>)[key];
    if (typeof value === "function") {
      Object.defineProperty(facade, key, {
        value: value.bind(tools),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  Object.defineProperty(facade, "sendMessage", {
    value: (content: string, mentions?: Parameters<AdapterToolsProtocol["sendMessage"]>[1]) =>
      deliverReply(tools, content, mentions),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return facade;
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
