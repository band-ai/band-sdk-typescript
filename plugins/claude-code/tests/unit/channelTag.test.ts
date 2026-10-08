/** Which channel-tag lookalikes in a Band message reach Claude defused, and which text passes unchanged. */
import { describe, expect, it } from "vitest";

import { neutralizeChannelTags } from "../../src/channelTag";

// Listed apart from the source so a dropped or mistyped code point there fails here.
const OPEN_BRACKETS = [..."\u003C\uFF1C\uFE64\u2329\u27E8\u3008\u2039\u02C2\u1438\u276C\u276E\u2770\u29FC\u226E\u227A\u22D6"];
const CLOSE_BRACKETS = [..."\u003E\uFF1E\uFE65\u232A\u27E9\u3009\u203A\u02C3\u1433\u276D\u276F\u2771\u29FD\u226F\u227B\u22D7"];
/** One per invisible class (Cf, Cc, Mn, Me), then each blank Hangul filler. */
const INVISIBLES = [..."\u200B\u0001\u0301\u20DD\u115F\u1160\u3164\uFFA0"];
const codePoint = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

const ALREADY_DEFUSED = "<\\/channel> <\\channel>";
const COMPARISON = "a < b and channel";
const OTHER_TAG = "<b>bold</b>";
const NAME_BEFORE = "<a channel";
const UNDERSCORE_BEFORE = "<_channel";
const DIGIT_BEFORE = "<9channel";
const HYPHEN_BEFORE = "<-channel";
const CLOSED_BEFORE = "<div>channel";
const PLAIN = "run the tests";

describe("neutralizeChannelTags", () => {
  it.each([
    ["mixed case", "<CHANNEL a></Channel>", "<\\CHANNEL a><\\/Channel>"],
    ["several tags", "<channel></channel>", "<\\channel><\\/channel>"],
    ["a longer name", "<channels>", "<\\channels>"],
    ["a code block", "```\n<channel>\n```", "```\n<\\channel>\n```"],
    ["a quote", "> <channel>", "> <\\channel>"],
    ...OPEN_BRACKETS.map((bracket) => [`the bracket ${codePoint(bracket)}`, `${bracket}channel`, "<\\channel"]),
    ["a space after the bracket", "< channel", "<\\ channel"],
    ["a newline after the bracket", "<\nchannel", "<\\\nchannel"],
    ["two slashes", "<//channel", "<\\//channel"],
    ["slashes and a space", "</ /channel", "<\\/ /channel"],
    ["a bracket before the tag", "<<channel", "<<\\channel"],
    ["a bracket and a space before the tag", "< <channel", "< <\\channel"],
    ...INVISIBLES.map((char) => [`${codePoint(char)} in the name`, `<c${char}hannel`, `<\\c${char}hannel`]),
    ["stacked invisibles in the name", "<c\u200B\u0301hannel", "<\\c\u200B\u0301hannel"],
    ["fullwidth brackets and slash", "＜／channel＞", "<\\／channel＞"],
    ["already defused tags", ALREADY_DEFUSED, ALREADY_DEFUSED],
    ["a comparison before the word", COMPARISON, COMPARISON],
    ["another tag", OTHER_TAG, OTHER_TAG],
    ["a name before the word", NAME_BEFORE, NAME_BEFORE],
    ["an underscore before the word", UNDERSCORE_BEFORE, UNDERSCORE_BEFORE],
    ["a digit before the word", DIGIT_BEFORE, DIGIT_BEFORE],
    ["a hyphen before the word", HYPHEN_BEFORE, HYPHEN_BEFORE],
    ["a closed tag before the word", CLOSED_BEFORE, CLOSED_BEFORE],
    ...CLOSE_BRACKETS.map((bracket) => [`the closing bracket ${codePoint(bracket)} before the word`, `<${bracket}channel`, `<${bracket}channel`]),
    ["plain text", PLAIN, PLAIN],
  ])("%s", (_case, input, expected) => {
    expect(neutralizeChannelTags(input)).toBe(expected);
    expect(neutralizeChannelTags(expected)).toBe(expected);
  });
});
