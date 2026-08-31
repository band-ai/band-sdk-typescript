import type { Logger } from "../core/logger";

/** The part of a session record this module needs: something with a closable transport. */
interface ClosableSession {
  transport: { close: () => Promise<void> };
}

/**
 * Closes every supplied session, reporting failures instead of letting one abort the rest.
 *
 * `Promise.all` would reject on the first failing transport, leaving the remaining
 * sessions open and skipping whatever the caller does after teardown.
 */
export async function closeSessionTransports(
  entries: Array<[string, ClosableSession]>,
  operation: string,
  logger: Logger,
): Promise<void> {
  const results = await Promise.allSettled(
    entries.map(async ([, session]) => { await session.transport.close(); }),
  );

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.warn("Failed to close MCP session transport", {
        operation,
        sessionId: entries[index]?.[0],
        error: result.reason,
      });
    }
  });
}
