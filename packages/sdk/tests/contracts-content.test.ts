import { describe, expect, it } from "vitest";

import { EVENT_EMPTY_CONTENT_PLACEHOLDER, hasVisibleContent, withVisibleEventContent } from "../src/contracts/content";

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

  // A non-string stringifies into the regex ("undefined" -> "undefined") and would read as visible.
  it.each([undefined, null, 42, {}])("is not fooled by non-string input (%j)", (input) => {
    expect(hasVisibleContent(input)).toBe(false);
  });
});

describe("withVisibleEventContent", () => {
  it.each([
    ["", EVENT_EMPTY_CONTENT_PLACEHOLDER],
    ["   ", EVENT_EMPTY_CONTENT_PLACEHOLDER],
    [ZERO_WIDTH_SPACE, EVENT_EMPTY_CONTENT_PLACEHOLDER],
  ] as const)("substitutes the placeholder for blank content (%j)", (input, expected) => {
    expect(withVisibleEventContent(input)).toBe(expected);
  });

  it.each(["hello", "  hi  "] as const)("leaves visible content unchanged (%j)", (input) => {
    expect(withVisibleEventContent(input)).toBe(input);
  });
});
