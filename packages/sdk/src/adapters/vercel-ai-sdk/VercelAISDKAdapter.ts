import { ToolCallingAdapter, type ToolCallingAdapterOptions } from "../tool-calling";

import {
  VercelAISDKToolCallingModel,
  type VercelAISDKToolCallingModelOptions,
} from "./model";

/**
 * Options for {@link VercelAISDKAdapter}: everything {@link ToolCallingAdapterOptions}
 * accepts, plus the Vercel AI SDK model and the `generateText`/tool factory hooks.
 */
export interface VercelAISDKAdapterOptions
  extends Omit<ToolCallingAdapterOptions, "toolFormat" | "model">,
    VercelAISDKToolCallingModelOptions {}

/**
 * Adapter for the Vercel AI SDK (`ai`). Runs the tool-calling loop through `generateText`,
 * so any provider the AI SDK supports can back a Band agent.
 *
 * Requires the optional peer dependency `ai`.
 */
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
    });
  }
}
