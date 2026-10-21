---
name: band-typescript-conventions
description: "Band TypeScript SDK conventions for source, API design, comments, errors, and package boundaries. Read before editing TypeScript in this workspace."
---

# TypeScript Conventions

## Design and ownership

- Prefer small functions with one concern and direct, declarative control flow.
  Reuse established helpers before introducing abstractions.
- Find the existing source of truth for every value and rule. Use named
  constants, discriminated unions, schemas, or small intent-named helpers;
  do not repeat protocol strings or reconstruct a policy owned by SDK Core.
- Types are part of the API. Preserve inference, named public options
  interfaces (`<Framework>AdapterOptions`), and compatibility for callers.
- Keep existing adapters' `new XAdapter(options)` pattern. Prefer factories
  for new top-level entry points that apply defaults or inject dependencies.
- Validate untrusted input at the owning boundary, using the existing schema
  and inferred types where available. `BandLink` uses Core's
  `validateEventPayload`; do not recreate local payload rules.
- Put shared auth, retry, and error handling at the common request boundary.
  Defaults must be predictable; new retries require a supported failure model.
- Follow `AGENTS.md` for lifecycle ownership, central turn judgment, tools,
  REST wire shapes, and contact strategy. Preserve borrowed versus owned
  resources and release partially initialized owned resources on failure.

## TypeScript and package boundaries

- Read the affected package's `tsconfig.json`, ESLint config, and manifest.
  SDK source uses strict TypeScript, ESNext and Bundler resolution with
  `verbatimModuleSyntax`; follow surrounding import paths rather than adding
  `.js` everywhere. Use `import type` for type-only imports.
- No explicit `any` in SDK source. Narrow unknown external values instead of
  asserting away a boundary. Prefer named exports and domain-specific types.
- Framework packages are optional peers. Preserve lazy-loading and import
  isolation, and keep peers external in `tsup.config.ts`.
- Public changes must work through the declared ESM, CJS, and declaration
  exports. `package.json#exports` and the tsup entries own output mappings.
- Follow each manifest's Node engine and the root's pinned toolchain; root,
  SDK, and plugins need not declare the same minimum. Do not change engines
  as incidental cleanup.
- Prefer async/await for sequential work and explicit error ownership.
  Preserve promise identity when sharing an in-flight operation; an `async`
  wrapper must not change that contract. Never leave a rejected promise or
  cancelled provider operation unobserved.

## Logging and errors

Use the `Logger` interface and `resolveLogger` from
`packages/sdk/src/core/logger.ts`. Log concise messages with structured
context through `debug`, `info`, `warn`, or `error`; do not use printf
placeholders. Wrap injected loggers with `resolveLogger` so logging failures
do not replace the original error. Avoid `console`
in library code when logger context exists. Record useful failure context
without credentials, raw prompts, or sensitive message contents.

Use the existing typed SDK errors so callers can distinguish failures without
parsing text. Catch at an actual recovery/translation/cleanup boundary; preserve
causes and do not convert failure into silent success.

## Comment Style

Keep comments short and explain non-obvious reasons, invariants, and ownership.
Avoid narrating the next line. No issue IDs or tracker URLs in source/comments;
put those in commits, PRs, or tickets. Split unrelated concerns rather than
explaining a tangled function with long comments.

Before committing, reread the diff for duplicated concepts and assertions or
casts that conceal a broken contract. Linters do not establish design quality.
