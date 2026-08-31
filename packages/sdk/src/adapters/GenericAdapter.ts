import { SimpleAdapter } from "../core/simpleAdapter";
import type { AdapterToolsProtocol } from "../contracts/protocols";
import type { HistoryProvider, PlatformMessage } from "../runtime/types";

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

/**
 * Adapter that wraps a plain async function instead of an LLM SDK. Use it to run arbitrary
 * per-message logic — a scripted bot, a proxy to your own service, or a test double —
 * without writing an adapter class.
 */
export class GenericAdapter extends SimpleAdapter<HistoryProvider> {
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
  }
}
