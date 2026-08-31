import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";
import type { ToolCallingModel } from "../tool-calling";
import {
  AnthropicToolCallingModel,
  type AnthropicClientFactory,
} from "./model";

/**
 * Options for {@link AnthropicAdapter}. Everything {@link ToolCallingAdapterOptions}
 * accepts, plus the Claude model name, API key, response token budget, and hooks to supply
 * your own client or a pre-built {@link ToolCallingModel}.
 */
export interface AnthropicAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model"> {
  model?: ToolCallingModel;
  anthropicModel?: string;
  apiKey?: string;
  maxTokens?: number;
  clientFactory?: AnthropicClientFactory;
}

/**
 * Adapter for Anthropic's `@anthropic-ai/sdk`. Exposes the Band platform tools as Claude
 * tools and runs the tool-calling loop against the Messages API.
 *
 * Requires the optional peer dependency `@anthropic-ai/sdk`.
 */
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
    });
  }
}
