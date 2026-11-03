import { GenerateContentResponse } from "@google/genai";

import type { GeminiGenerateResponseLike } from "../../src/adapters/gemini/model";

type GeminiPart = Record<string, unknown>;

/** A real SDK response whose first candidate holds `parts`, so `text` and `functionCalls` derive as they do live. */
export function geminiResponse(...parts: GeminiPart[]): GeminiGenerateResponseLike {
  return Object.assign(new GenerateContentResponse(), {
    candidates: [{ content: { role: "model", parts } }],
  });
}

export function geminiCall(
  name: string,
  args: Record<string, unknown>,
  options: { id?: string; thoughtSignature?: string } = {},
): GeminiPart {
  const { id, thoughtSignature } = options;
  return {
    functionCall: { name, args, ...(id ? { id } : {}) },
    ...(thoughtSignature ? { thoughtSignature } : {}),
  };
}
