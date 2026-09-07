import { SimpleAdapter } from "../core/simpleAdapter";
import { RecoverableTurnError } from "../core/errors";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { HistoryProvider, PlatformMessage } from "../runtime/types";
import { asErrorMessage } from "./shared/coercion";
import { agentFailure, reportTurnFailure } from "./shared/providerFailure";

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
        tools,
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
