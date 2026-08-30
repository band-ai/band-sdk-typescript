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
// generated `requestWithRetries`. These are the intended single-layer retry
// budgets for getAgentMe (4 attempts) and message/event sends (3 attempts).
// The prior code nested a hand-rolled outer retry loop around a Fern call
// that also retried internally, so its worst-case wire attempts were higher
// (up to 16 and 12, respectively) than these numbers suggest.
export const AGENT_ME_MAX_RETRIES = 3;
export const MESSAGE_SEND_MAX_RETRIES = 2;
