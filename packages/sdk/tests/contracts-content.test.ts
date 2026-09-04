import { describe, expect, it } from "vitest";

import { hasVisibleContent } from "../src/contracts/content";

const ZERO_WIDTH_SPACE = "\u200B";
const LEFT_TO_RIGHT_MARK = "\u200E";

// Table mirrors the platform's own `Chat.validate_visible_content/1` cases:
// every letter/number/punctuation/symbol is visible, everything else
// (whitespace, zero-width, bidi marks) is not.
describe("hasVisibleContent", () => {
  it.each([
    ["", false],
    ["   ", false],
    ["\n\t ", false],
    [ZERO_WIDTH_SPACE, false],
    [LEFT_TO_RIGHT_MARK, false],
    ["0", true],
    ["hello", true],
    ["\u{1F600}", true],
    ["  hi  ", true],
  ] as const)("hasVisibleContent(%j) === %s", (input, expected) => {
    expect(hasVisibleContent(input)).toBe(expected);
  });

  // A non-string reaching the regex stringifies (`undefined` -> "undefined")
  // and would read as visible, letting a blank send through to the platform.
  it.each([undefined, null, 42, {}])("is not fooled by non-string input (%j)", (input) => {
    expect(hasVisibleContent(input as unknown as string)).toBe(false);
  });
});
