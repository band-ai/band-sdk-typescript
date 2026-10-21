# Vetting a third-party library

Used by the research phase for each serious candidate. Cite the release,
tagged source, and package metadata behind each conclusion.

- **Maintenance:** releases, issue responsiveness, maintainer continuity,
  and relevant adoption.
- **Fit:** license, the affected package's Node engine, ESM/CJS consumers,
  declaration compatibility, cancellation support, and dependency weight.
- **Workspace compatibility:** inspect package manifests, optional peers,
  `pnpm-lock.yaml`, tsup externals, and downstream SDK/plugin consumers.
  Never bundle an optional framework peer or require it on unrelated imports.
- **Released capability:** verify the installed version's JavaScript and types,
  not only latest docs. Probe uncertain behavior in an isolated worktree;
  record any unverified claim and the experiment needed to settle it.
