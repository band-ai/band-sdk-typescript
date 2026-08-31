import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";
import type { ToolCallingModel } from "../tool-calling";
import {
  OpenAIToolCallingModel,
  type OpenAIClientFactory,
} from "./model";

/**
 * Options for {@link OpenAIAdapter}. Everything {@link ToolCallingAdapterOptions} accepts,
 * plus the OpenAI model name, API key, and hooks to supply your own client or a
 * pre-built {@link ToolCallingModel}.
 */
export interface OpenAIAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model"> {
  model?: ToolCallingModel;
  openAIModel?: string;
  apiKey?: string;
  clientFactory?: OpenAIClientFactory;
}

/**
 * Adapter for OpenAI's `openai` SDK. Exposes the Band platform tools as OpenAI function
 * tools and runs the tool-calling loop against the Chat Completions API.
 *
 * Requires the optional peer dependency `openai`.
 */
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
    });
  }
}
