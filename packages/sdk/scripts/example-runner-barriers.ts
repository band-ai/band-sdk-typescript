/** Shared plan step barrier rules for example-runner and its tests. */
export function assertReplyOnlyBarrier(barrier: string): void {
  if (barrier !== "reply") {
    throw new Error(
      `unsupported barrier: ${barrier} (TypeScript example-runner only implements reply)`,
    );
  }
}
