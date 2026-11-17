import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { isToolExecutorError } from "../../contracts/protocols";
import { BAND_TOOL_EFFECTS } from "../../contracts/toolSchemas";
import { overrideTools } from "../../core/overrideTools";
import { bandToolOverrides } from "../../core/turn";
import { DeliveryUnknownError } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";

/** Thrown for a reply or decline made after its turn was cut short: the post must not go out. */
export class TurnCutShortError extends Error {
  public constructor() {
    super("The turn was cut short; its reply must not be posted");
    this.name = "TurnCutShortError";
  }
}

function isDeliveryUnknownToolResult(result: unknown): boolean {
  return isToolExecutorError(result) && result.details?.kind === DeliveryUnknownError.KIND;
}

/**
 * Wraps the tools a turn runs on, keeping the turn's side of the runtime's
 * durable publications honest:
 *
 * - a reply or decline made after the turn was cut short is refused before
 *   any post, so a reply a turn lost cannot still go out;
 * - a classified delivery-unknown (thrown, or surfaced as a tool-executor
 *   error) fences this turn's closing text. The fence stands on the wrapper
 *   itself — the adapter's turn object reads it through
 *   `unknownDeliveryFenced` — so a late result fences the turn it ran on and
 *   cannot reach a successor, which wraps its own tools.
 *
 * The durable intent and settlement themselves live in the runtime's
 * publication engine, which the context's tools already carry; this wrapper
 * only owns the turn's own behavior around them.
 */
export function journalingTools<T extends AdapterToolsProtocol>(
  tools: T,
  stopped: AbortSignal,
  logger?: Logger,
): T {
  // Set once this turn had a reply whose delivery stands unknown; the adapter's
  // turn reads it through the wrapper it runs on.
  let fenced = false;

  const wrapCall = (call: () => Promise<unknown>): Promise<unknown> => {
    if (stopped.aborted) {
      throw new TurnCutShortError();
    }
    return call().then(
      (result) => {
        if (isDeliveryUnknownToolResult(result)) {
          fenced = true;
        }
        return result;
      },
      (error: unknown) => {
        if (error instanceof DeliveryUnknownError) {
          fenced = true;
        } else {
          logger?.debug("a turn's reply delivery failed", { error });
        }
        throw error;
      },
    );
  };

  const overrides = bandToolOverrides(tools, (toolName, call) => {
    const effect = BAND_TOOL_EFFECTS[toolName];
    return effect === "reply" || effect === "decline" ? wrapCall(call) : call();
  });

  return overrideTools(tools, {
    ...overrides,
    unknownDeliveryFenced: () => fenced,
  } as unknown as Partial<T>);
}