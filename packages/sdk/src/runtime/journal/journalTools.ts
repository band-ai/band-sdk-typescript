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
 * The mark a keyed call's admission leaves on the turn it fences: the MCP
 * transport decorator resolves the turn's tools at the raw call and sets this
 * flag before the framework's validation, so a keyed call — valid or not —
 * fences the turn it was admitted on the same way a delivery-unknown reply
 * would, and the turn's closing text is never relayed as an unkeyed
 * replacement.
 */
export const KEYED_ADMISSION_FENCE = Symbol("band.keyedAdmissionFence");

/**
 * A read function the tools an AgentTools stands behind carry: true once the
 * room's current turn made a canonical keyed call — a send or a no-reply that
 * carries an `operation_id`, valid or not, accepted or refused. Such a call
 * commits the turn to keyed delivery, so the turn's closing text is never
 * relayed as an unkeyed replacement on top of it. The stand the flag reads on
 * is the room's current turn stop, so a fence earned in one turn cannot reach
 * a successor, and a call made with no turn standing fences nothing.
 */
export const KEYED_TURN_FENCE = Symbol("band.keyedTurnFence");

/** Fences the turn standing behind `tools`, when its wrappers carry the fence. */
export function fenceTurnForKeyedAdmission(tools: unknown): void {
  const fence = (tools as { [KEYED_ADMISSION_FENCE]?: { fence: () => void } } | undefined)?.[KEYED_ADMISSION_FENCE];
  try {
    fence?.fence();
  } catch {
    // A fence that throws has not fenced; the call still runs.
  }
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
  // Set once this turn had a reply whose delivery stands unknown, or ran a
  // keyed canonical call that the runtime's tools fence through their own
  // flag; the adapter's turn object reads it through the wrapper it runs on.
  let fenced = false;

  const underlyingKeyedFence = (tools as unknown as { [KEYED_TURN_FENCE]?: () => boolean } | undefined)?.[KEYED_TURN_FENCE];

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
    unknownDeliveryFenced: () => {
      if (fenced) {
        return true;
      }
      try {
        return underlyingKeyedFence?.() === true;
      } catch {
        return false;
      }
    },
    [KEYED_ADMISSION_FENCE]: { fence: () => { fenced = true; } },
  } as unknown as Partial<T>);
}