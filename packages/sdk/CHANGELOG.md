# Changelog


## [0.4.0](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.3.4...sdk-v0.4.0) (2026-09-17)


### ⚠ BREAKING CHANGES

* **sdk:** `maxHistoryMessages: 0` now replays no history. It previously returned the entire history, because the old call site ended in `.slice(-limit)` and `-0 === 0` makes `slice(0)` a no-op. A negative value likewise dropped that many turns from the front and now replays nothing. Callers relying on `0` to mean "unlimited" should omit the option or pass an explicit cap.
* **sdk:** public zod-typed surfaces (CustomToolDef.schema, the exported payload schemas) are now zod 4 types; consumers passing zod 3 schemas must upgrade to zod 4.
* **sdk:** A2A gateway status-update failure metadata renames error_type -> code and error_message -> message, and adds provider and detail keys. Remote A2A clients reading the old keys must switch to the new ones.

### Features

* **adapters:** add resolveSessionModel hook to ACPClientAdapter ([#196](https://github.com/band-ai/band-sdk-typescript/issues/196)) ([21c1e39](https://github.com/band-ai/band-sdk-typescript/commit/21c1e393f564a61bf2a466a0f8cf85c0cd4a4ebc))
* add GitHub Copilot CLI ACP support ([#218](https://github.com/band-ai/band-sdk-typescript/issues/218)) ([cf15460](https://github.com/band-ai/band-sdk-typescript/commit/cf15460379a724d342f141a314e992c29513cda4))
* Integrate band-sdk-core memory taxonomy into band-sdk-typescript ([#187](https://github.com/band-ai/band-sdk-typescript/issues/187)) ([1da6b2e](https://github.com/band-ai/band-sdk-typescript/commit/1da6b2e51e35825dfc9a9947f0b156396df3ed0b))
* **sdk:** add OmpACPAdapter (INT-1473) ([#219](https://github.com/band-ai/band-sdk-typescript/issues/219)) ([59c2dd4](https://github.com/band-ai/band-sdk-typescript/commit/59c2dd4f01975634a0ac7098369c3d97c46345bc))
* **sdk:** add platform-supported agent scope to memory tools (INT-1422) ([#191](https://github.com/band-ai/band-sdk-typescript/issues/191)) ([06702e6](https://github.com/band-ai/band-sdk-typescript/commit/06702e67e1b2aa31d629cbd0f83793e501046966))
* **sdk:** Add structured adapter failure reporting ([#178](https://github.com/band-ai/band-sdk-typescript/issues/178)) ([5d9a66a](https://github.com/band-ai/band-sdk-typescript/commit/5d9a66a1dde4989fbc0608200f291f0ca8194052))
* **sdk:** integrate band-sdk-core SubscriptionTracker into BandLink (INT-1324) ([6a8dc02](https://github.com/band-ai/band-sdk-typescript/commit/6a8dc023eeb5a64d7bdcb44d1125313d0d187d84))
* **sdk:** validate inbound events with core ([8079af6](https://github.com/band-ai/band-sdk-typescript/commit/8079af699b01c88ce102ce9662318bd2355e3eb1))
* **sdk:** validate inbound events with core (INT-1237) ([f1bed4f](https://github.com/band-ai/band-sdk-typescript/commit/f1bed4f6e3d87882b1f2adea5d5d162af8c43a61))
* **websocket:** integrate core subscription tracking (INT-1324) ([b36fb1c](https://github.com/band-ai/band-sdk-typescript/commit/b36fb1cfbfa8fc5664a6fda2b374917d00781334))


### Bug Fixes

* **ci:** make the test suite run truthfully and let CI report on main ([#167](https://github.com/band-ai/band-sdk-typescript/issues/167)) ([d0eaade](https://github.com/band-ai/band-sdk-typescript/commit/d0eaade871f163b92794fa87de78f63f173f0956))
* **sdk:** align core event projections ([f513301](https://github.com/band-ai/band-sdk-typescript/commit/f5133012f73deccc81143158457e4c7c4c4a6f14))
* **sdk:** guard remaining caller loggers ([#220](https://github.com/band-ai/band-sdk-typescript/issues/220)) ([0eef7c1](https://github.com/band-ai/band-sdk-typescript/commit/0eef7c15c8c5f98abf6ed335b67da15db791a003))
* **sdk:** migrate from zod 3 to zod 4 ([#164](https://github.com/band-ai/band-sdk-typescript/issues/164)) ([c206564](https://github.com/band-ai/band-sdk-typescript/commit/c206564fe4e81301c2abff9014a208872dd5fa50))
* **sdk:** model compact core event payloads ([686ebd6](https://github.com/band-ai/band-sdk-typescript/commit/686ebd673f68c1d70227b6075e3c2d07b027ecd4))
* **sdk:** normalize absent supersede retry delay ([6fde2df](https://github.com/band-ai/band-sdk-typescript/commit/6fde2dfb066454436773e6fa69efb6df8f70ef76))
* **sdk:** rework runtime lifecycle bugs as a state machine ([#161](https://github.com/band-ai/band-sdk-typescript/issues/161)) ([10bacdc](https://github.com/band-ai/band-sdk-typescript/commit/10bacdccd459c3fa490e50e50727db102da6c261))
* **sdk:** stop Parlant dropping messages in multi-turn history ([#166](https://github.com/band-ai/band-sdk-typescript/issues/166)) ([47fc3ca](https://github.com/band-ai/band-sdk-typescript/commit/47fc3cadc46736ec8a112f2a0f9c0b2c5560c36d))
* **sdk:** surface JSON-RPC error data/cause instead of dropping it ([#195](https://github.com/band-ai/band-sdk-typescript/issues/195)) ([c9d552c](https://github.com/band-ai/band-sdk-typescript/commit/c9d552cdfe9a31b02673f14c42541a3d7a50ba97))
* **sdk:** update for @agentclientprotocol/sdk v1 ([#214](https://github.com/band-ai/band-sdk-typescript/issues/214)) ([8ee508d](https://github.com/band-ai/band-sdk-typescript/commit/8ee508d388aa38a088645d4aab67e6b52fdc4ad3))
* **sdk:** update for @band-ai/rest-client v0.0.143 ([#212](https://github.com/band-ai/band-sdk-typescript/issues/212)) ([6a86bb4](https://github.com/band-ai/band-sdk-typescript/commit/6a86bb40a4b5cced63247f83ed38f9b03f2851f8))
* **sdk:** update for js-yaml v5 ([#211](https://github.com/band-ai/band-sdk-typescript/issues/211)) ([93b333d](https://github.com/band-ai/band-sdk-typescript/commit/93b333d9aaae098e6bad5fd98691c6bd448a25aa))
* **sdk:** update for zod v4 ([#213](https://github.com/band-ai/band-sdk-typescript/issues/213)) ([c5ef5dd](https://github.com/band-ai/band-sdk-typescript/commit/c5ef5dd0fabf836104a5b2c13a2e29abc6a97127))

## [0.3.4](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.3.3...sdk-v0.3.4) (2026-09-14)


### Bug Fixes

* **acp:** keep a text/thought run open across the other streamed type ([#207](https://github.com/band-ai/band-sdk-typescript/issues/207)) ([bc3ee65](https://github.com/band-ai/band-sdk-typescript/commit/bc3ee65d0b3040e96db4053abad9bb6c64454e98))
* **sdk:** bump @band-ai/band-sdk-core to latest (2.4.0) ([#193](https://github.com/band-ai/band-sdk-typescript/issues/193)) ([4ea059f](https://github.com/band-ai/band-sdk-typescript/commit/4ea059f05b8d954650f1c496727c696c882084c8))

## [0.3.3](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.3.2...sdk-v0.3.3) (2026-09-13)


### Bug Fixes

* **adapters:** coalesce streamed ACP chunks before posting to the room ([#189](https://github.com/band-ai/band-sdk-typescript/issues/189)) ([c0dccf4](https://github.com/band-ai/band-sdk-typescript/commit/c0dccf42cfd4f74ccb71ddd61fb009f2d9a8c74c))

## [0.3.2](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.3.1...sdk-v0.3.2) (2026-09-08)


### Bug Fixes

* **adapters:** Register the ACP permission handler once per connection ([#185](https://github.com/band-ai/band-sdk-typescript/issues/185)) ([f1069b3](https://github.com/band-ai/band-sdk-typescript/commit/f1069b3ac95cd11b5391766edcf221712a84375b))

## [0.3.1](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.3.0...sdk-v0.3.1) (2026-09-07)


### Features

* **acp:** configure advertised session modes ([#179](https://github.com/band-ai/band-sdk-typescript/issues/179)) ([a793110](https://github.com/band-ai/band-sdk-typescript/commit/a7931103476fa461b41b5fdc20be5ac3f41b7b58))

## [0.3.0](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.2.1...sdk-v0.3.0) (2026-09-07)


### ⚠ BREAKING CHANGES

* linear_thenvoi_bridge/linear_thenvoi_transport are no longer recognized as config-key aliases, and LINEAR_THENVOI_* env vars no longer fall back for the Linear bridge example. Use linear_band_bridge and LINEAR_BAND_* instead.

### Features

* **runtime:** integrate RoomRoster into the TypeScript room lifecycle ([#177](https://github.com/band-ai/band-sdk-typescript/issues/177)) ([aa3a5f0](https://github.com/band-ai/band-sdk-typescript/commit/aa3a5f0d0378ead7b0c3aa823f525abe857d735e))


### Bug Fixes

* **adapters:** switch a session into its requested permission mode ([#181](https://github.com/band-ai/band-sdk-typescript/issues/181)) ([107de93](https://github.com/band-ai/band-sdk-typescript/commit/107de937002ae6b64acb3993d1232724ad605cd9))
* remove legacy Thenvoi config-key and env-var fallbacks from the Linear bridge example ([#175](https://github.com/band-ai/band-sdk-typescript/issues/175)) ([b28e799](https://github.com/band-ai/band-sdk-typescript/commit/b28e7999f4d7231e73a4456c2e99d2e8eeb18b39))
* **sdk:** stabilize ACP relay, prompting, and room context ([#171](https://github.com/band-ai/band-sdk-typescript/issues/171)) ([d3cb29a](https://github.com/band-ai/band-sdk-typescript/commit/d3cb29a83938ebeb8f51cf885e3f4986adb5ab1c))

## [0.2.1](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.2.0...sdk-v0.2.1) (2026-09-03)


### Features

* **adapters:** add resolvePermission extension point for manual permission approval ([#170](https://github.com/band-ai/band-sdk-typescript/issues/170)) ([624983a](https://github.com/band-ai/band-sdk-typescript/commit/624983a70172d1ce2d94d5c44d4cf18bd773be86))

## [0.2.0](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.1.10...sdk-v0.2.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* **sdk:** MessageRetryTracker and ParticipantTracker are removed from the public runtime barrel with no back-compat shim -- band-sdk-core's RetryTracker/ParticipantRoster replace them, with an identical method surface. AgentTools's `participants?: ParticipantRecord[]` constructor option is replaced by `roster?: ParticipantRoster` (still optional, defaulting to an owned instance) -- only a caller passing `participants:` explicitly needs to migrate to `roster:`.
* **sdk:** LinearThenvoiBridgeConfig → LinearBandBridgeConfig, LinearThenvoiBridgeDeps → LinearBandBridgeDeps (field thenvoiRest → bandRest). LinearThenvoiExampleRestApi → LinearBandExampleRestApi.

### Features

* **sdk:** integrate band-sdk-core retry and participant roster (INT-1246) ([#163](https://github.com/band-ai/band-sdk-typescript/issues/163)) ([212339e](https://github.com/band-ai/band-sdk-typescript/commit/212339eb06f42fb5ee9e1939559dd55413da580d))
* **sdk:** rename Thenvoi SDK surfaces to Band ([#150](https://github.com/band-ai/band-sdk-typescript/issues/150)) ([3173431](https://github.com/band-ai/band-sdk-typescript/commit/3173431029c8938158af17d3523e484d62aeedb5))


### Bug Fixes

* **sdk:** authenticate the ACP MCP bridge and fail loudly on unadvertised transport (INT-1356) ([#168](https://github.com/band-ai/band-sdk-typescript/issues/168)) ([6fbcd8b](https://github.com/band-ai/band-sdk-typescript/commit/6fbcd8bca04ee5b755dcd507a498c123d4d47493))
* **sdk:** close remaining MCP-bridge gaps found in review of [#168](https://github.com/band-ai/band-sdk-typescript/issues/168) ([#169](https://github.com/band-ai/band-sdk-typescript/issues/169)) ([58fd81f](https://github.com/band-ai/band-sdk-typescript/commit/58fd81ffe1e3a752fc088e087abd1458c5e6b28b))
* **sdk:** remove duplicate 429 retry loop in FernRestAdapter ([#162](https://github.com/band-ai/band-sdk-typescript/issues/162)) ([831dbf1](https://github.com/band-ai/band-sdk-typescript/commit/831dbf1ec69a1e96d41c29a7286f8fca226c861b))

## [0.1.10](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.1.9...sdk-v0.1.10) (2026-08-09)


### Bug Fixes

* **release:** point package repository URLs at band-ai/band-sdk-typescript ([#154](https://github.com/band-ai/band-sdk-typescript/issues/154)) ([09acead](https://github.com/band-ai/band-sdk-typescript/commit/09acead90200c7904eb8ba81aa4fe0e196ad6031))

## [0.1.9](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.1.8...sdk-v0.1.9) (2026-08-09)


### Features

* fix LangGraph streaming adapter event parsing and history … ([#121](https://github.com/band-ai/band-sdk-typescript/issues/121)) ([#152](https://github.com/band-ai/band-sdk-typescript/issues/152)) ([160dd19](https://github.com/band-ai/band-sdk-typescript/commit/160dd197a9049d95700eea8bef922903327f7286))

## [0.1.8](https://github.com/band-ai/band-sdk-typescript/compare/sdk-v0.1.7...sdk-v0.1.8) (2026-08-05)


### Bug Fixes

* **sdk:** normalize participant handle prefixes ([#148](https://github.com/band-ai/band-sdk-typescript/issues/148)) ([1db703b](https://github.com/band-ai/band-sdk-typescript/commit/1db703b27b30ac48da3c58fe7e21d551bbb881c9))

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
