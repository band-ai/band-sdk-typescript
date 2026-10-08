/** Which channel-tag lookalikes in a Band message reach Claude defused, and which text passes unchanged. */
import { describe, expect, it } from "vitest";

import { neutralizeChannelTags } from "../../src/channelTag";

// Listed apart from the source so a dropped or mistyped code point there fails here.
const OPEN_BRACKETS = [..."<＜﹤〈⟨〈‹˂ᐸ❬❮❰⧼≮≺⋖"];
/** One per invisible class (Cf, Cc, Mn, Me), then each blank Hangul filler. */
const INVISIBLES = [..."​\u0001́⃝ᅟᅠㅤﾠ"];
const codePoint = (char: string) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

const ALREADY_DEFUSED = "<\\/channel> <\\channel>";
const COMPARISON = "a < b and channel";
const OTHER_TAG = "<b>bold</b>";
const NAME_BEFORE = "<a channel";
const UNDERSCORE_BEFORE = "<_channel";
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
    ...INVISIBLES.map((char) => [`${codePoint(char)} after the bracket`, `<${char}channel`, `<\\${char}channel`]),
    ...INVISIBLES.map((char) => [`${codePoint(char)} in the name`, `<c${char}hannel`, `<\\c${char}hannel`]),
    ["fullwidth brackets and slash", "＜／channel＞", "<\\／channel＞"],
    ["already defused tags", ALREADY_DEFUSED, ALREADY_DEFUSED],
    ["a comparison before the word", COMPARISON, COMPARISON],
    ["another tag", OTHER_TAG, OTHER_TAG],
    ["a name before the word", NAME_BEFORE, NAME_BEFORE],
    ["an underscore before the word", UNDERSCORE_BEFORE, UNDERSCORE_BEFORE],
    ["a closed tag before the word", CLOSED_BEFORE, CLOSED_BEFORE],
    ["plain text", PLAIN, PLAIN],
  ])("%s", (_case, input, expected) => {
    expect(neutralizeChannelTags(input)).toBe(expected);
    expect(neutralizeChannelTags(expected)).toBe(expected);
  });
});
