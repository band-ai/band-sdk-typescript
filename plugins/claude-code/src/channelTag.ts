/** The tag Claude Code wraps each channel event in. */
export const CHANNEL_TAG = "channel";

/** `<` and the characters Claude Code reads as `<`. */
const OPEN_BRACKETS =
  "<＜﹤〈⟨〈‹˂ᐸ❬❮❰⧼≮≺⋖";
/** Their `>` counterparts, which end the gap before a tag name. */
const CLOSE_BRACKETS =
  ">＞﹥〉⟩〉›˃ᐳ❭❯❱⧽≯≻⋗";
/** Characters a reader doesn't see inside a tag name. */
const INVISIBLE = String.raw`\p{Cf}\p{Cc}\p{Mn}\p{Me}ᅟᅠㅤﾠ`;
const NAME_CHARS = String.raw`A-Za-z0-9_\-`;

/** A not-yet-defused bracket opening or closing a `channel` lookalike; the gap and the name's first letter are disjoint, so matching stays linear. */
const TAG_LOOKALIKE = new RegExp(
  `[${OPEN_BRACKETS}](?!\\\\)(?=[^${NAME_CHARS}${OPEN_BRACKETS}${CLOSE_BRACKETS}]*${[...CHANNEL_TAG].join(`[${INVISIBLE}]*`)})`,
  "giu",
);

/**
 * Claude Code defuses only closing tags in a channel body, so a message could forge an opening one.
 * Rewrites each lookalike's bracket to `<\`, Claude Code's own defused form.
 */
export function neutralizeChannelTags(text: string): string {
  return text.replace(TAG_LOOKALIKE, "<\\");
}
