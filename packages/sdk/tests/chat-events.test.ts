import { describe, expect, it } from "vitest";

import { isBlankEventContent } from "../src/contracts/chatEvents";

const ZERO_WIDTH_SPACE = "\u200B";
const LEFT_TO_RIGHT_MARK = "\u200E";

// Table mirrors the platform's own `Chat.validate_visible_content/1` cases:
// every letter/number/punctuation/symbol is visible, everything else
// (whitespace, zero-width, bidi marks) is not -- a plain `.trim().length`
// check would wrongly call the zero-width/bidi cases non-blank.
describe("isBlankEventContent", () => {
  it.each([
    ["", true],
    ["   ", true],
    ["\n\t ", true],
    [ZERO_WIDTH_SPACE, true],
    [LEFT_TO_RIGHT_MARK, true],
    ["0", false],
    ["hello", false],
    ["\u{1F600}", false],
    ["  hi  ", false],
  ] as const)("isBlankEventContent(%j) === %s", (input, expected) => {
    expect(isBlankEventContent(input)).toBe(expected);
  });
});
