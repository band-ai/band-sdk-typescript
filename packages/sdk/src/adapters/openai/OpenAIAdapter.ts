import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";
import type { ToolCallingModel } from "../tool-calling";
import {
  OpenAIToolCallingModel,
  type OpenAIClientFactory,
} from "./model";

export interface OpenAIAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model" | "provider"> {
  model?: ToolCallingModel;
  openAIModel?: string;
  apiKey?: string;
  clientFactory?: OpenAIClientFactory;
}

export class OpenAIAdapter extends ToolCallingAdapter {
  public constructor(options: OpenAIAdapterOptions = {}) {
    const {
      model,
      openAIModel,
      apiKey,
      clientFactory,
      ...adapterOptions
    } = options;

    const resolvedModel = model ?? new OpenAIToolCallingModel({
      model: openAIModel ?? "gpt-5.2",
      apiKey,
      clientFactory,
    });

    super({
      ...adapterOptions,
      model: resolvedModel,
      toolFormat: "openai",
      provider: "openai",
    });
  }
}
