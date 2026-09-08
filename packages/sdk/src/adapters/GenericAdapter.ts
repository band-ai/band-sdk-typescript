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
 * Every other property reads through to the real `tools` via the prototype
 * chain, unchanged.
 *
 * `Object.create(tools)`, not a `Proxy` over it: `AgentTools.buildAdapterTools()`
 * hands adapters an `Object.freeze`d object, and a `Proxy` `get` trap returning
 * anything other than a frozen own property's exact stored value — as the
 * `sendMessage` override below must — violates the Proxy invariant for
 * non-configurable, non-writable data properties and throws a `TypeError`.
 * Delegating through the prototype chain instead has no such invariant:
 * reads for every other property fall through to `tools` regardless of
 * whether it holds them as frozen own properties (this SDK's own
 * `AgentTools`) or as prototype methods (a class-based `AdapterToolsProtocol`
 * implementation, e.g. a test double) — an ordinary property copy would miss
 * the latter, since prototype methods aren't own-enumerable.
 * `Object.defineProperty`, not plain assignment, for the one property this
 * shadows: assigning through a prototype chain onto a non-writable inherited
 * data property throws, the same restriction this exists to route around.
 */
function toolsWithDeliverySafeSendMessage(tools: AdapterToolsProtocol): AdapterToolsProtocol {
  const facade = Object.create(tools) as AdapterToolsProtocol;
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
