import type { AdapterToolsProtocol } from "../../contracts/protocols";
import { BAND_TOOL_EFFECTS } from "../../contracts/toolSchemas";
import { overrideTools } from "../../core/overrideTools";
import { Serializer } from "../../core/singleFlight";
import { bandToolOverrides } from "../../core/turn";
import { DeliveryUnknownError, isDeliveryUnknownOutput } from "../../core/deliveryFailedError";
import type { Logger } from "../../core/logger";
import { cutShort } from "../turnRevocation";
import { JournalPublicationError } from "./errors";

/**
 * Wraps the tools a turn runs on, keeping the turn's side of the runtime's
 * durable publications honest:
 *
 * - a reply or decline made after the turn was cut short is refused before
 *   any post, so a reply a turn lost cannot still go out;
 * - a classified delivery-unknown (thrown, or surfaced as a tool-executor
 *   error) fences this turn: its later replies and closing text are refused
 *   rather than posted beside a reply Band may hold. Replies run one at a
 *   time, so one made while another is in flight waits for its outcome. The
 *   fence stands on the wrapper itself — the adapter's turn object reads it
 *   through `unknownDeliveryFenced` — so a late result fences the turn it ran
 *   on and cannot reach a successor, which wraps its own tools.
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
  // A turn's replies post one at a time, so each sees the fence the one before
  // it may have raised rather than post beside a reply still in doubt.
  const replies = new Serializer();

  const observe = (call: () => Promise<unknown>): Promise<unknown> => call().then(
    (result) => {
      if (isDeliveryUnknownOutput(result)) {
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

  const reply = (call: () => Promise<unknown>): Promise<unknown> => replies.run(() => {
    if (fenced) {
      throw new JournalPublicationError(
        "This turn already has a reply whose delivery is unknown; a replacement is refused rather than posted beside it",
        "fenced",
      );
    }
    return observe(call);
  });

  const wrapCall = (call: () => Promise<unknown>, effect: "reply" | "decline"): Promise<unknown> => {
    const refused = cutShort(stopped);
    if (refused) throw refused;
    return effect === "reply" ? reply(call) : observe(call);
  };

  const overrides = bandToolOverrides(tools, (toolName, call) => {
    const effect = BAND_TOOL_EFFECTS[toolName];
    return effect === "reply" || effect === "decline" ? wrapCall(call, effect) : call();
  });

  return overrideTools(tools, {
    ...overrides,
    unknownDeliveryFenced: () => fenced,
  } as Partial<T>);
}
