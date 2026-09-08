import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";

import {
  VercelAISDKToolCallingModel,
  type VercelAISDKToolCallingModelOptions,
} from "./model";

export interface VercelAISDKAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model" | "provider">,
    VercelAISDKToolCallingModelOptions {}

export class VercelAISDKAdapter extends ToolCallingAdapter {
  public constructor(options: VercelAISDKAdapterOptions) {
    const {
      model,
      generateText,
      toolFactory,
      ...adapterOptions
    } = options;

    super({
      ...adapterOptions,
      model: new VercelAISDKToolCallingModel({
        model,
        generateText,
        toolFactory,
      }),
      toolFormat: "openai",
      provider: "vercel-ai-sdk",
    });
  }
}
