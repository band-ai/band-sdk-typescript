---
name: band-pr-assess
description: >-
  Assess a PR's goal, design fit, and scope, file follow-up tickets when needed,
  then always run band-code-review --fix until it converges before any
  approve/merge. Use when the user asks to assess, evaluate, or quality-check a
  PR end-to-end toward merge (/band-pr-assess), or asks whether a change is the
  right cross-system design before shipping. Not a substitute for band-pr-triage
  alone; merge is forbidden until band-code-review --fix has converged.
argument-hint: "[target]"
---

# PR Assess

End-to-end path from “what is this PR?” to merge-ready: design/scope judgment,
follow-ups, then the mandatory `band-code-review --fix` gate. It is not a
read-only triage (`band-pr-triage`) and not a review-only pass
(`band-code-review` without `--fix`).

Follow [workflow-runtime.md](../workflow-runtime.md) for tools, delegation,
authorization, and cleanup.

## Invocation

`/band-pr-assess [target]`

- **target** — PR number, URL, or branch; none means the current branch’s PR.

## Hard gate

**Never** approve, enable auto-merge, merge, or recommend MERGE until
`band-code-review --fix <target>` has **converged** for this PR (see that
skill’s [cycles.md](../band-code-review/cycles.md): zero verified in-scope
`issue:` findings; nits/suggestions fixed in the converging round).

- Running review/fix is required, not optional.
- **Converged** → proceed to ship only if the user asked.
- **Capped** or **not converging** → do not merge; report the signal, keep
  threads open per that skill, and stop for a user decision (design fix /
  rethink / stop). Do not treat “review finished” or “last cycle’s fixes
  pushed” as success without convergence.
- Out-of-scope defects deferred only with Linear tickets (or an explicit
  leave-open decision); they do not block convergence, but merge still needs
  that disposition settled.

## Steps

### 1. Goal

Resolve the PR (`gh pr view`, description, diff summary). Write 2–4 sentences:
problem, what ships, what is explicitly out of scope. Note missing/stale ticket
linkage.

### 2. Design fit

Judge whether this is the right seam for the claimed fix across systems:

- Ownership: runtime vs adapter vs platform vs in-process host
- Consistency with existing optional-capability / API patterns in this repo
- Vertical slice (good foundation) vs incomplete coverage sold as complete

Verdict, one concrete reason each: **right API** / **right first cut** /
**wrong layer**.

### 3. Scope call

Default: keep a focused vertical slice in this PR. Broader backends, platform
wire paths, or sibling adapters are **separate work** unless omitting them
makes this change incorrect.

State clearly: stay narrow vs expand here (and why).

### 4. Follow-ups

When scope or review leaves real gaps (including proven out-of-scope defects):

- File Integrations backlog tickets assigned to the user (`me`) unless they
  name someone else
- Shape: Context / Do / Depends / Not this ticket — informative, no fluff
- Link the PR; relate sibling tickets
- Do not expand this PR to absorb those tickets unless step 3 said to

Ask before filing if the user has not already asked for tickets.

### 5. Required review/fix (must converge)

Run [band-code-review](../band-code-review/SKILL.md) with **`--fix`** on the
same target. Follow that skill fully (workspace, simplify, cycles, root-cause
fixes, thread close-out). Do not substitute a lighter scan or triage verdict.

Drive the loop until it **converges**. If the run is capped or not converging,
halt for the user per that skill — do not approve/merge and do not invent a
bolt-on to force a green report.

Out-of-scope findings from that run: file follow-ups (step 4) or get an
explicit user decision (fix now / defer with ticket / leave open). Deferred
items need a ticket before merge.

### 6. Ship

Only after step 5 has **converged**:

- Summarize goal, design verdict, scope call, tickets filed, review/fix
  outcome (converged; cycles run)
- Then approve and merge (or queue) only if the user asked and CI/merge-queue
  gates allow — never bypass required checks

If design is **wrong layer**, stop before or after review as appropriate; do
not merge a knowingly wrong seam.

## Output

Short sections matching steps 1–6. No restated PR body. End with:

- Tickets filed (links) or none
- `band-code-review --fix`: converged (cycles N) / capped / not converging /
  blocked (why)
- Merge: not yet / queued / merged (link)

## Not this skill

- Cheap merge/heavy-review signal only → `band-pr-triage`
- Review without the assess/follow-up framing, or without `--fix` when the
  user only asked for a review pass → `band-code-review` as invoked
- Security-only → `band-security-review`
