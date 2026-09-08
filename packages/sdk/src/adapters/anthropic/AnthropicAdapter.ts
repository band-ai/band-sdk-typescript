import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";
import type { ToolCallingModel } from "../tool-calling";
import {
  AnthropicToolCallingModel,
  type AnthropicClientFactory,
} from "./model";

export interface AnthropicAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model" | "provider"> {
  model?: ToolCallingModel;
  anthropicModel?: string;
  apiKey?: string;
  maxTokens?: number;
  clientFactory?: AnthropicClientFactory;
}

export class AnthropicAdapter extends ToolCallingAdapter {
  public constructor(options: AnthropicAdapterOptions = {}) {
    const {
      model,
      anthropicModel,
      apiKey,
      maxTokens,
      clientFactory,
      ...adapterOptions
    } = options;

    const resolvedModel = model ?? new AnthropicToolCallingModel({
      model: anthropicModel ?? "claude-sonnet-4-6",
      apiKey,
      maxTokens,
      clientFactory,
    });

    super({
      ...adapterOptions,
      model: resolvedModel,
      toolFormat: "anthropic",
      provider: "anthropic",
    });
  }
}
