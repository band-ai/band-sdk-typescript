/** Resolves after `ms` milliseconds. Used by the retry/backoff paths across the SDK. */
export async function sleep(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
