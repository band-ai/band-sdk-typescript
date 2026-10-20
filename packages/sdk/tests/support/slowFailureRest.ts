import { createDeferred } from "../../src/core/deferred";
import { FAILURE_EVENT_TYPE } from "../../src/contracts/protocols";
import { RecordingRestApi } from "../flows/support/bandPlatform";

/** A slow network for the failure event only: the provider is already done while its failure is still being delivered. */
export class SlowFailureRest extends RecordingRestApi {
  public readonly failurePosting = createDeferred();
  public readonly gate = createDeferred();

  public override async createChatEvent(roomId: string, event: Parameters<RecordingRestApi["createChatEvent"]>[1]) {
    if (event.messageType === FAILURE_EVENT_TYPE) {
      this.failurePosting.resolve();
      await this.gate.promise;
    }
    return super.createChatEvent(roomId, event);
  }
}
