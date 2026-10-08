/** The tag Claude Code wraps each channel event in. */
export const CHANNEL_TAG = "channel";

/** `<` and the characters Claude Code reads as `<`. */
const OPEN_BRACKETS = "\u003C\uFF1C\uFE64\u2329\u27E8\u3008\u2039\u02C2\u1438\u276C\u276E\u2770\u29FC\u226E\u227A\u22D6";
/** Their `>` counterparts, which end the gap before a tag name. */
const CLOSE_BRACKETS = "\u003E\uFF1E\uFE65\u232A\u27E9\u3009\u203A\u02C3\u1433\u276D\u276F\u2771\u29FD\u226F\u227B\u22D7";
/** Characters a reader doesn't see inside a tag name; the last four are blank Hangul fillers. */
const INVISIBLE = String.raw`\p{Cf}\p{Cc}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0`;
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
