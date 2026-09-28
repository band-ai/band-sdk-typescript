import { randomUUID } from "node:crypto";

/** A fresh marker a model can only produce by being told it. */
export function uniqueMarker(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}
