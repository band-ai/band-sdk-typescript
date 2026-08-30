export interface RestRequestOptions {
  maxRetries?: number;
  timeoutInSeconds?: number;
  headers?: Record<string, string>;
}

export const DEFAULT_REQUEST_OPTIONS: RestRequestOptions = {
  maxRetries: 3,
};

// `maxRetries` here counts retries *after* the first attempt (total attempts
// = maxRetries + 1) — it flows straight into `@band-ai/rest-client`'s
// generated `requestWithRetries`. These per-operation values are one less
// than FernRestAdapter's pre-existing total-attempt counts, so its
// getAgentMe and message/event sends keep making the same number of
// attempts they always did.
export const AGENT_ME_MAX_RETRIES = 3;
export const MESSAGE_SEND_MAX_RETRIES = 2;
