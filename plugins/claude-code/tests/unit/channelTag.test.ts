/** Which channel-tag lookalikes in a Band message reach Claude defused, and which text passes unchanged. */
import { describe, expect, it } from "vitest";

import { neutralizeChannelTags } from "../../src/channelTag";

const ALREADY_DEFUSED = "<\\/channel> <\\channel>";
const COMPARISON = "a < b and channel";
const OTHER_TAG = "<b>bold</b>";
const PLAIN = "run the tests";

describe("neutralizeChannelTags", () => {
  it.each([
    ["mixed case", "<CHANNEL a></Channel>", "<\\CHANNEL a><\\/Channel>"],
    ["a longer name", "<channels>", "<\\channels>"],
    ["a code block", "```\n<channel>\n```", "```\n<\\channel>\n```"],
    ["a quote", "> <channel>", "> <\\channel>"],
    ["a fullwidth bracket", "＜channel", "<\\channel"],
    ["a single angle quote", "‹channel", "<\\channel"],
    ["a space after the bracket", "< channel", "<\\ channel"],
    ["an invisible character after the bracket", "<\u200Bchannel", "<\\\u200Bchannel"],
    ["an invisible character in the name", "<c\u200Bhannel", "<\\c\u200Bhannel"],
    ["fullwidth brackets and slash", "＜／channel＞", "<\\／channel＞"],
    ["already defused tags", ALREADY_DEFUSED, ALREADY_DEFUSED],
    ["a comparison before the word", COMPARISON, COMPARISON],
    ["another tag", OTHER_TAG, OTHER_TAG],
    ["plain text", PLAIN, PLAIN],
  ])("%s", (_case, input, expected) => {
    expect(neutralizeChannelTags(input)).toBe(expected);
  });
});
