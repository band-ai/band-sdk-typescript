import { z } from "zod";
import type { Band } from "@band-ai/rest-client";

export const DEFAULT_WORKING_REQUEST_TIMEOUT_SECONDS = 2;

export const activitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reasoning") }),
  z.strictObject({ kind: z.literal("tool_call"), name: z.string().min(1).max(1024) }),
  z.strictObject({ kind: z.literal("memory") }),
  z.strictObject({ kind: z.literal("permission") }),
]) satisfies z.ZodType<Band.AgentActivityDetail>;

export type Activity = Readonly<z.infer<typeof activitySchema>>;
export const REASONING: Activity = Object.freeze({ kind: "reasoning" });
export const MEMORY: Activity = Object.freeze({ kind: "memory" });
export const PERMISSION: Activity = Object.freeze({ kind: "permission" });

export function toolCall(name: string): Activity {
  return Object.freeze({ kind: "tool_call", name });
}

export function sameActivity(left: Activity, right: Activity): boolean {
  return left.kind === right.kind &&
    (left.kind !== "tool_call" || (right.kind === "tool_call" && left.name === right.name));
}
