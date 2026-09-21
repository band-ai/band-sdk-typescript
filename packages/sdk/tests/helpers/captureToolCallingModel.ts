import type {
  ToolCallingModel,
  ToolCallingModelRequest,
  ToolCallingResponse,
} from "../../src/adapters/tool-calling";

export class CaptureToolCallingModel implements ToolCallingModel {
  public readonly requests: ToolCallingModelRequest[] = [];

  public async complete(request: ToolCallingModelRequest): Promise<ToolCallingResponse> {
    this.requests.push(request);
    return { text: "ok" };
  }
}
