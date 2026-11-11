import { randomUUID } from "node:crypto";

/** The random part of a marker: the only part that proves a model was told it. */
const CODE_LENGTH = 8;

/**
 * A fresh marker a model can only produce by being told it. One unbroken code
 * (`NOTE0A832EC4`), not `note-0a832ec4`: a separate word-like label reads as a
 * description, and models drop it.
 */
export function uniqueMarker(label: string): string {
  return `${label}${randomUUID().slice(0, CODE_LENGTH)}`.toUpperCase();
}

/**
 * Whether `text` carries `marker`'s random code, label or not. A prompt that
 * names the label ("a note with a token" for `NOTE…`) can still lead a model
 * to drop it, and the code alone shows the model was told the marker.
 */
export function carriesMarkerCode(text: string, marker: string): boolean {
  return text.toUpperCase().includes(marker.slice(-CODE_LENGTH));
}
