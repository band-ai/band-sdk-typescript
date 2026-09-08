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
 * Every other property is forwarded to the real `tools` unchanged, bound to
 * it so an implementation's internal `this` usage still resolves correctly.
 */
function toolsWithDeliverySafeSendMessage(tools: AdapterToolsProtocol): AdapterToolsProtocol {
  return new Proxy(tools, {
    get(target, prop, receiver): unknown {
      if (prop === "sendMessage") {
        return (content: string, mentions?: Parameters<AdapterToolsProtocol["sendMessage"]>[1]) =>
          deliverReply(target, content, mentions);
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
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
