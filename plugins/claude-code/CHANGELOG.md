# Changelog

## [0.2.0](https://github.com/band-ai/band-sdk-typescript/compare/claude-code-plugin-v0.1.0...claude-code-plugin-v0.2.0) (2026-10-30)


### Features

* **claude-code:** Band only with its channel; ask which agent at every start ([#320](https://github.com/band-ai/band-sdk-typescript/issues/320)) ([696702a](https://github.com/band-ai/band-sdk-typescript/commit/696702a8fd4481d94c7b8d5feb6342e01d092eff))
* **claude-code:** reply-first Band toolkit with rules-only instructions ([#319](https://github.com/band-ai/band-sdk-typescript/issues/319)) ([968c01f](https://github.com/band-ai/band-sdk-typescript/commit/968c01f493c3ba56ede0e5e3aaf46146c92bb3ae))
* **claude-code:** suggest reachable agents as MCP resources ([#322](https://github.com/band-ai/band-sdk-typescript/issues/322)) ([64dab84](https://github.com/band-ai/band-sdk-typescript/commit/64dab845a97611b5da2ac4c04ceeee00531d964a))
* **runtime:** maintain boolean working state through execution lifetimes ([#342](https://github.com/band-ai/band-sdk-typescript/issues/342)) ([e4d63ad](https://github.com/band-ai/band-sdk-typescript/commit/e4d63add31e95761264a23b8b48bd7235380370b))
* **sdk:** room board tools under core names, listed by the Claude Code plugin ([#321](https://github.com/band-ai/band-sdk-typescript/issues/321)) ([eeb3e7f](https://github.com/band-ai/band-sdk-typescript/commit/eeb3e7f301c8c29ff0c200741f9638025dbd6bca))


### Bug Fixes

* **claude-code:** neutralize channel-tag lookalikes in Band messages ([#316](https://github.com/band-ai/band-sdk-typescript/issues/316)) ([e1e0427](https://github.com/band-ai/band-sdk-typescript/commit/e1e0427ebe5ff49de368a7223cd85677eb794dbe))
* **claude-code:** preserve channel-owned working state ([#343](https://github.com/band-ai/band-sdk-typescript/issues/343)) ([54f9558](https://github.com/band-ai/band-sdk-typescript/commit/54f955895bef1d5140b3e528089d22e6a0b2afaf))
* repair live baseline failures and report complete nightly results ([#315](https://github.com/band-ai/band-sdk-typescript/issues/315)) ([76cf5f4](https://github.com/band-ai/band-sdk-typescript/commit/76cf5f4c8d48ab6f620ffbb0b1c032de0dbfcec4))


### Documentation

* **claude-code:** document internal PoC setup and development commands ([#323](https://github.com/band-ai/band-sdk-typescript/issues/323)) ([9564682](https://github.com/band-ai/band-sdk-typescript/commit/95646822ea94c1354ed0c85ed3e10e632bf3b6ff))

## 0.1.0 (2026-10-05)


### Features

* add [@band-ai](https://github.com/band-ai) dual-publish support ([#22](https://github.com/band-ai/band-sdk-typescript/issues/22)) ([ada247f](https://github.com/band-ai/band-sdk-typescript/commit/ada247fb13d48385d787388b1cd57cbb7891a2df))
* **claude-code:** add the Band Claude Code channel plugin (INT-1664) ([#305](https://github.com/band-ai/band-sdk-typescript/issues/305)) ([48a2a11](https://github.com/band-ai/band-sdk-typescript/commit/48a2a1161a1f76b10a5ceb1d45cf616a09a9a2f9))
* **claude-code:** let each Claude Code session connect as a different Band agent (INT-1676) ([#307](https://github.com/band-ai/band-sdk-typescript/issues/307)) ([330c66e](https://github.com/band-ai/band-sdk-typescript/commit/330c66eeb25c21333211f4086168f3c8531ab463))
* **claude-code:** use Band tools in any of the agent's rooms (INT-1682) ([#310](https://github.com/band-ai/band-sdk-typescript/issues/310)) ([6167dd6](https://github.com/band-ai/band-sdk-typescript/commit/6167dd6b34c8740df557800a1d65e8ddeff58473))
