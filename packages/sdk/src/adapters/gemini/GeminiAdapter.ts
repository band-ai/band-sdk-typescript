import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";
import type { ToolCallingModel } from "../tool-calling";
import {
  GeminiToolCallingModel,
  type GeminiClientFactory,
} from "./model";

/**
 * Options for {@link GeminiAdapter}. Everything {@link ToolCallingAdapterOptions} accepts,
 * plus the Gemini model name, API key, and hooks to supply your own client or a pre-built
 * {@link ToolCallingModel}.
 */
export interface GeminiAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model"> {
  model?: ToolCallingModel;
  geminiModel?: string;
  apiKey?: string;
  clientFactory?: GeminiClientFactory;
}

/**
 * Adapter for Google's `@google/genai` SDK. Exposes the Band platform tools as Gemini
 * function declarations and runs the tool-calling loop against the Gemini API.
 *
 * Requires the optional peer dependency `@google/genai`.
 */
export class GeminiAdapter extends ToolCallingAdapter {
  public constructor(options: GeminiAdapterOptions = {}) {
    const {
      model,
      geminiModel,
      apiKey,
      clientFactory,
      ...adapterOptions
    } = options;

    const resolvedModel = model ?? new GeminiToolCallingModel({
      model: geminiModel ?? "gemini-3-flash-preview",
      apiKey,
      clientFactory,
    });

    super({
      ...adapterOptions,
      model: resolvedModel,
      // Gemini's OpenAI-compatible endpoint accepts OpenAI-format tool schemas.
      toolFormat: "openai",
    });
  }
}
