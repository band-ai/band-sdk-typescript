---
name: band-pr-assess
description: >-
  Assess a PR's goal, design fit, and scope, file follow-up tickets when needed,
  then run band-code-review --fix until it converges before any approve/merge
  (skip that gate on a wrong-layer stop). Use when the user asks to assess,
  evaluate, or quality-check a PR end-to-end toward merge (/band-pr-assess), or
  asks whether a change is the right cross-system design before shipping. Not a
  substitute for band-pr-triage alone; merge is forbidden until review/fix has
  converged.
argument-hint: "[target]"
---

# PR Assess

End-to-end path from "what is this PR?" to merge-ready: design/scope judgment,
follow-ups, then the mandatory `band-code-review --fix` gate. It is not a
read-only triage (`band-pr-triage`) and not a review-only pass
(`band-code-review` without `--fix`).

Follow [workflow-runtime.md](../workflow-runtime.md) for tools, delegation,
authorization, and cleanup. Finishing this skill does not mark a draft ready,
establish peer approval, or waive required CI/merge-queue checks.

## Invocation

`/band-pr-assess [target]`

- **target** — PR number, URL, or branch; none means the current branch's PR.

## Hard gate

**Never** approve, enable auto-merge, merge, or recommend MERGE until
`band-code-review --fix <target>` has **converged** for this PR (see that
skill's [cycles.md](../band-code-review/cycles.md): zero verified in-scope
`issue:` findings; nits/suggestions fixed in the converging round).

Applies only when this run is still headed toward ship. A **wrong layer**
verdict (step 2) stops the run before the gate — do not run review/fix or
merge to paper over the wrong seam.

When the gate applies:

- Running review/fix is required, not optional. Invoke
  `band-code-review --fix` **once** (default `--cycles`); do not re-invoke
  to force a green outcome.
- **Converged** → proceed to ship only if the user asked.
- **Capped** or **not converging** → do not merge; report the signal, keep
  threads open per that skill, and stop for a user decision (design fix /
  rethink / stop). "Review finished" or "last cycle's fixes pushed" is not
  success without convergence.
- Out-of-scope defects need Linear tickets (or an explicit leave-open
  decision) before merge; they do not block convergence.

## Steps

### 1. Target, scope, workspace

Follow [pr-target-scope.md](../band-code-review/pr-target-scope.md) and
prepare the checkout per
[pr-workspace.md](../band-here-is-a-review/pr-workspace.md) (fixes and
tickets need a synced head with push access). Write 2–4 sentences: problem,
what ships, what is explicitly out of scope. Note missing/stale ticket
linkage. Carry that scope statement through later steps.

### 2. Design fit

Judge whether this is the right seam for the claimed change:

- **Ownership** — which layer owns the behavior (e.g. runtime vs adapter vs
  platform vs host; or skill/guidance vs product code vs CI)
- **Consistency** — matches existing optional-capability, API, or workflow
  patterns in this repo
- **Completeness claim** — vertical slice (good foundation) vs incomplete
  coverage sold as complete

Verdict, one concrete reason each: **right API** / **right first cut** /
**wrong layer**.

If **wrong layer**: report the verdict and stop. Do not run step 5 or ship.

### 3. Scope call

Default: keep a focused vertical slice in this PR. Broader backends, platform
wire paths, sibling adapters, or adjacent skills are **separate work** unless
omitting them makes this change incorrect.

State clearly: stay narrow vs expand here (and why). If the PR is part of a
stack, note that and follow [band-stacked-prs](../band-stacked-prs/SKILL.md)
only when stack mechanics matter for merge order.

### 4. Follow-ups

When scope or review leaves real gaps (including proven out-of-scope defects):

- File Integrations backlog tickets assigned to the user (`me`) unless they
  name someone else
- Shape: Context / Do / Depends / Not this ticket — informative, no fluff
- Link the PR; relate sibling tickets
- Do not expand this PR to absorb those tickets unless step 3 said to

Ask before filing if the user has not already asked for tickets.

### 5. Required review/fix (must converge)

Unless step 2 stopped the run, run
[band-code-review](../band-code-review/SKILL.md) with **`--fix`** on the
same target. Follow that skill fully (workspace, simplify, cycles,
root-cause fixes, thread close-out). Do not substitute a lighter scan or
triage verdict.

Use that single run's outcome. If capped or not converging, halt for the
user per that skill — do not approve/merge and do not invent a bolt-on to
force a green report.

Out-of-scope findings from that run: file follow-ups (step 4) or get an
explicit user decision (fix now / defer with ticket / leave open). Deferred
items need a ticket before merge.

### 6. Ship

Only after step 5 has **converged**, and only if the user asked to ship:

- Confirm author readiness against `AGENTS.md` "PR Lifecycle and Readiness
  Review" before promoting a draft or merging
- Summarize goal, design verdict, scope call, tickets filed, review/fix
  outcome (converged; cycles run)
- Approve and merge (or queue) only when CI/merge-queue gates allow — never
  bypass required checks

## Output

Short sections matching steps 1–6. No restated PR body. End with:

- Tickets filed (links) or none
- `band-code-review --fix`: converged (cycles N) / capped / not converging /
  skipped (wrong layer) / blocked (why)
- Merge: not yet / queued / merged (link)

## Not this skill

- Cheap merge/heavy-review signal only → `band-pr-triage`
- Review without the assess/follow-up framing, or without `--fix` when the
  user only asked for a review pass → `band-code-review` as invoked
- Security-only → `band-security-review`
