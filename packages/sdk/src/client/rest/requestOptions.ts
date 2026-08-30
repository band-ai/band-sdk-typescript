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
// generated `requestWithRetries`. getAgentMe uses the shared default above
// (4 attempts); message/event sends get a tighter override below (3
// attempts) to bound duplicate-send risk. The prior code nested a
// hand-rolled outer retry loop around a Fern call that also retried
// internally, so its worst-case wire attempts were higher (up to 16 and 12,
// respectively) than these numbers suggest.
export const MESSAGE_SEND_MAX_RETRIES = 2;
