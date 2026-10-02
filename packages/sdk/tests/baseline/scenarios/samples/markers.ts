import { randomUUID } from "node:crypto";

/**
 * A fresh marker a model can only produce by being told it. One unbroken code
 * (`NOTE0A832EC4`), not `note-0a832ec4`: a separate word-like label reads as a
 * description, and models drop it.
 */
export function uniqueMarker(label: string): string {
  return `${label}${randomUUID().slice(0, 8)}`.toUpperCase();
}
