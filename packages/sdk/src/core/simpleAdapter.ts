import {
  isSyntheticTurn,
  type FrameworkAdapter,
  type FrameworkAdapterInput,
  type HistoryConverter,
  type HistoryLike,
  type PlatformMessageLike,
} from "../contracts/protocols";
import { reportTurnFailure } from "./providerFailure";
import { missingReplyFailure, trackTurn, type TurnTools } from "./turn";

/**
 * Base class for framework adapters that process one message at a time.
 *
 * Subclass this and implement {@link onMessage} to build a custom adapter.
 * Built-in adapters (OpenAI, Anthropic, Gemini, etc.) already extend this.
 *
 * Each turn gets its own {@link TurnTools}. A turn that ends without
 * replying, declining (`band_no_reply`), acting, settling or reporting is
 * reported with band-sdk-core's missing-reply text and fails.
 *
 * @typeParam H - Converted history format your adapter expects (e.g. OpenAI messages array).
 * @typeParam TTools - Tool interface exposed to the adapter (defaults to {@link TurnTools}).
 */
export abstract class SimpleAdapter<H, TTools = TurnTools>
  implements FrameworkAdapter
{
  /** `AgentFailure.provider` identity for every failure this adapter reports. */
  protected abstract readonly provider: string;

  protected historyConverter?: HistoryConverter<H>;
  protected agentName = "";
  protected agentDescription = "";

  public constructor(options?: { historyConverter?: HistoryConverter<H> }) {
    this.historyConverter = options?.historyConverter;
  }

  public abstract onMessage(
    message: PlatformMessageLike,
    tools: TTools,
    history: H,
    participantsMessage: string | null,
    contactsMessage: string | null,
    context: {
      isSessionBootstrap: boolean;
      roomId: string;
    },
  ): Promise<void>;

  /** False for an adapter whose turns owe no reply of their own, such as a bridge to another agent. */
  protected get judgesTurns(): boolean {
    return true;
  }

  public async onCleanup(_roomId: string): Promise<void> {}

  public async onStarted(agentName: string, agentDescription: string): Promise<void> {
    this.agentName = agentName;
    this.agentDescription = agentDescription;
  }

  public async onEvent(input: FrameworkAdapterInput): Promise<void> {
    const tools = trackTurn(input.tools, this.judgesTurns && !isSyntheticTurn(input.message));
    const history = this.convertHistory(input.history);
    await this.onMessage(
      input.message,
      tools as TTools,
      history,
      input.participantsMessage,
      input.contactsMessage,
      {
        isSessionBootstrap: input.isSessionBootstrap,
        roomId: input.roomId,
      },
    );
    if (!tools.turn.detached && tools.turn.unanswered) {
      await reportTurnFailure(tools, missingReplyFailure());
    }
  }

  private convertHistory(provider: HistoryLike): H {
    if (!this.historyConverter) {
      return provider as H;
    }

    return provider.convert(this.historyConverter);
  }
}
