import type { Band } from "@band-ai/rest-client";

export interface RestRequestOptions {
  abortSignal?: AbortSignal;
  maxRetries?: number;
  timeoutInSeconds?: number;
  headers?: Record<string, string>;
}

export interface ReportActivityOptions extends RestRequestOptions {
  activity?: Band.AgentActivityDetail;
}

export const DEFAULT_REQUEST_OPTIONS: RestRequestOptions = {
  maxRetries: 3,
};

// `maxRetries` counts retries *after* the first attempt (total attempts =
// maxRetries + 1). getAgentMe uses the shared default above (4 attempts).
// Sends are capped tighter (3 attempts) to bound duplicate-send risk: an
// event send hands this to `@band-ai/rest-client`'s own retries, while a
// message send makes each attempt itself (`deliverMessage`) so it can read
// the room back before resending.
export const MESSAGE_SEND_MAX_RETRIES = 2;
