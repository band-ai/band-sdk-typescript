# Changelog


## [0.1.7](https://github.com/thenvoi/thenvoi-sdk-typescript/compare/sdk-v0.1.6...sdk-v0.1.7) (2026-06-17)


### Features

* add single-room Claude SDK MCP mode ([#44](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/44)) ([e827f2c](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/e827f2c800b0c86a42880ff2ccf1144f0e5fd9dd))
* adopt Linear's structured Agent Plans API ([#46](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/46)) ([6b40002](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/6b40002a1e6d59fead6da3bb17f6261339080fac))
* automatically move issues to started when agent begins work ([#48](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/48)) ([7464646](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/746464644850ba8d6c11e5d89484e616e658170a))
* automatically set agent as delegate on Linear issues ([#47](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/47)) ([38d1a6a](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/38d1a6a1d260930eb08a57b05c25dc37b5532ab6))
* **linear:** add Dockerfile and session tools for bridge agent ([#63](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/63)) ([484cd95](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/484cd9510656a4bd5fa1520ed3fd2730bfb87667))
* **linear:** add linear_suggest_repositories tool (INT-316) ([#52](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/52)) ([bfdd5ae](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/bfdd5ae351ac1c5d2c32e4dae83e335efa355085))
* **linear:** add stale session detection and keepalive mechanism ([#57](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/57)) ([12d9bc2](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/12d9bc20136cdab563220d0abef2f5ad1ad17d5b))
* **linear:** handle inbox notification webhooks (INT-315) ([#53](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/53)) ([d49b662](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/d49b662eaf74afff81b56f4d0e9ca532ed7b6924))
* **linear:** handle permission change webhooks from Linear ([#56](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/56)) ([27c539f](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/27c539f1f400c2989cd5485b1aa2676f80f8bce2))
* **linear:** rename agent to Band Linear PM (INT-310) ([#61](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/61)) ([8b99327](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/8b993275f7a9624a41e0587507281e22ee165558))
* **linear:** support bidirectional initiation — create Linear sessions from Thenvoi ([#60](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/60)) ([2da0ccf](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/2da0ccf48558a77a38a7ad5fcc6587e166044c64))
* **sdk:** export CustomToolDef from root entrypoint [INT-334] ([#72](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/72)) ([a9c046b](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/a9c046b70a9852366d1ce4171f6be8c504ffd063))
* **sdk:** export system prompt context from SDK MCP [INT-293] ([#45](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/45)) ([94136d2](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/94136d221d9f11d2aa11105ef5b78567501ff703))
* set session external URL to link back to Thenvoi room ([#50](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/50)) ([d182c48](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/d182c48a5ca965f365f6b4fd4dc5b6119d62e7b5))
* support select and auth elicitation signals for Linear agent ([#49](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/49)) ([7b94c5b](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/7b94c5b27aae73d53332ea3e5ba296c70369c61e))


### Bug Fixes

* add memory prompt guidance to prevent orphaned subject-scop… ([#87](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/87)) ([7d3c595](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/7d3c5952d3d8d9756b614875665da6876b413e4a))
* propagate logger to ThenvoiLink and forward wsUrl/restUrl in examples (INT-332) ([#55](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/55)) ([59d76bf](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/59d76bf516426adf3f822e48ad61117006369f35))
* **sdk:** surface websocket disconnect reasons [INT-331] ([#80](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/80)) ([d7afe81](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/d7afe816ba3a3d6b333f0d7bdcc77f680f67cd2e))
* widen optional peer dep ranges in @thenvoi/sdk ([#43](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/43)) ([38f034d](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/38f034d9964e2792f38ef3f2686b15f26ec62d88))

## [0.1.6](https://github.com/thenvoi/thenvoi-sdk-typescript/compare/sdk-v0.1.5...sdk-v0.1.6) (2026-04-05)


### Features

* add [@band-ai](https://github.com/band-ai) dual-publish support ([#22](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/22)) ([ada247f](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/ada247fb13d48385d787388b1cd57cbb7891a2df))
* **openclaw:** move OpenClaw channel into monorepo ([#16](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/16)) ([e0cee66](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/e0cee668046e52684d7e697b729bb7522ff8526f))
* publish packages to [@band-ai](https://github.com/band-ai) npm org ([#26](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/26)) ([aec24a0](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/aec24a0e7e28e257be585c10cdd63d08a3753916))


### Bug Fixes

* lazy-load ACP SDK and handle missing next-message endpoint ([#28](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/28)) ([efc3ce8](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/efc3ce811b2fa57b6d5af77541b430b7fdc7c7d4))
* lazy-load optional sdk peers ([#32](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/32)) ([8dd0072](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/8dd00722a877384abbc8df04452a8ca0618caf01))

## [0.1.5](https://github.com/thenvoi/thenvoi-sdk-typescript/compare/sdk-v0.1.4...sdk-v0.1.5) (2026-04-05)


### Bug Fixes

* lazy-load optional sdk peers to avoid missing module errors ([#32](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/32)) ([8dd0072](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/8dd0072))
* lazy-load ACP SDK and handle missing next-message endpoint ([#28](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/28)) ([efc3ce8](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/efc3ce8))


### Miscellaneous Chores

* bump @thenvoi/rest-client to 0.0.113 ([#31](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/31)) ([142d69e](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/142d69e))

## [0.1.4](https://github.com/thenvoi/thenvoi-sdk-typescript/compare/sdk-v0.1.3...sdk-v0.1.4) (2026-04-02)


### Features

* publish packages to [@band-ai](https://github.com/band-ai) npm org ([#26](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/26)) ([aec24a0](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/aec24a0e7e28e257be585c10cdd63d08a3753916))

## [0.1.3](https://github.com/thenvoi/thenvoi-sdk-typescript/compare/sdk-v0.1.2...sdk-v0.1.3) (2026-03-31)


### Features

* add [@band-ai](https://github.com/band-ai) dual-publish support ([#22](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/22)) ([ada247f](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/ada247fb13d48385d787388b1cd57cbb7891a2df))

## [0.1.2](https://github.com/thenvoi/thenvoi-sdk-typescript/compare/sdk-v0.1.1...sdk-v0.1.2) (2026-03-31)


### Features

* add [@band-ai](https://github.com/band-ai) dual-publish support ([#22](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/22)) ([ada247f](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/ada247fb13d48385d787388b1cd57cbb7891a2df))

## [0.1.1](https://github.com/thenvoi/thenvoi-sdk-typescript/compare/sdk-v0.1.0...sdk-v0.1.1) (2026-03-31)


### Features

* add [@band-ai](https://github.com/band-ai) dual-publish support ([#22](https://github.com/thenvoi/thenvoi-sdk-typescript/issues/22)) ([ada247f](https://github.com/thenvoi/thenvoi-sdk-typescript/commit/ada247fb13d48385d787388b1cd57cbb7891a2df))
