/** Whether Band's channel is on, read from the command lines Claude Code is really started with. */
import { describe, expect, it } from "vitest";

import { bandChannelOn } from "../../src/channelFlag";

const ON = [
  ["the README's launch", "claude --channels plugin:band@band-ai"],
  ["the option's = form", "claude --channels=plugin:band@band-ai"],
  ["the development channels option", "claude --dangerously-load-development-channels plugin:band@band-ai"],
  ["the README's local build", "claude --plugin-dir plugins/claude-code --dangerously-load-development-channels plugin:band@inline"],
  ["Band after another channel", "claude --channels server:x plugin:band@band-ai"],
  ["Band among several, before a prompt", "claude --model opus --channels plugin:discord@x plugin:band@band-ai -- fix the tests"],
  ["the allowlisted option in a print session", "claude -p --channels plugin:band@band-ai"],
  ["the development channels option before a prompt that mentions -p", "claude --dangerously-load-development-channels plugin:band@band-ai -- explain -p"],
] as const;

const OFF = [
  ["no options", "claude"],
  ["a print session", "claude -p hi"],
  ["only another plugin's channel", "claude --channels plugin:discord@x"],
  ["Band's entry after the option ended", "claude --channels plugin:other@x --model opus plugin:band@x"],
  ["Band's entry after the option's = form, which takes one value", "claude --channels=plugin:discord@x plugin:band@band-ai"],
  ["the development channels option in a print session, which ignores it", "claude -p --dangerously-load-development-channels plugin:band@band-ai"],
  ["the same with --print", "claude --print --dangerously-load-development-channels plugin:band@band-ai"],
  ["the option in a prompt after --", "claude -- Explain --channels plugin:band@band-ai"],
] as const;

describe("Band's channel", () => {
  it.each(ON)("is on for %s", (_, commandLine) => {
    expect(bandChannelOn(commandLine.split(/\s+/), {})).toBe(true);
  });

  it.each(OFF)("is off for %s", (_, commandLine) => {
    expect(bandChannelOn(commandLine.split(/\s+/), {})).toBe(false);
  });

  it("is on when Claude Code's command line can't be read", () => {
    expect(bandChannelOn(undefined, {})).toBe(true);
  });

  it("is on when a shell prefix wraps the server, whose parent is then the wrapper", () => {
    expect(bandChannelOn(["/bin/sh", "-c", "node server.js"], { CLAUDE_CODE_SHELL_PREFIX: "/usr/local/bin/wrap" })).toBe(true);
  });
});

it.each([
  [["claude", "--system-prompt", "--channels", "plugin:band@band-ai"], false],
  [["claude", "--dangerously-load-development-channels=plugin:band@band-ai", "--append-system-prompt", "-p"], true],
  [["claude", "--tools", "--channels", "plugin:band@band-ai"], false],
  [["claude", "--channels", "--print", "plugin:band@band-ai"], true],
] as const)("respects required option values in %j", (args, expected) => {
  expect(bandChannelOn(args, {})).toBe(expected);
});
