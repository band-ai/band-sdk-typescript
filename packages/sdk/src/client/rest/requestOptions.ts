export interface RestRequestOptions {
  maxRetries?: number;
  timeoutInSeconds?: number;
  headers?: Record<string, string>;
  /** Cancels the request, including any in-progress rate-limit backoff. */
  abortSignal?: AbortSignal;
}

export const DEFAULT_REQUEST_OPTIONS: RestRequestOptions = {
  maxRetries: 3,
};
