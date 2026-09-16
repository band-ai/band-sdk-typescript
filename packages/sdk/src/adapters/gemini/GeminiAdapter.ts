import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";
import type { ToolCallingModel } from "../tool-calling";
import {
  GeminiToolCallingModel,
  type GeminiClientFactory,
} from "./model";

export interface GeminiAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model" | "provider"> {
  model?: ToolCallingModel;
  geminiModel?: string;
  apiKey?: string;
  clientFactory?: GeminiClientFactory;
}

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
      provider: "gemini",
    });
  }
}
