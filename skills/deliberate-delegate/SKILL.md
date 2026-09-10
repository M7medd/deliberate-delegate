---
name: deliberate-delegate
description: Human-gated multi-agent coordination with durable project records, risk-sensitive planner review, awaitable Work Package execution, independent dual review, and bounded recovery.
license: MIT
metadata:
  version: 0.4.1
---

# Deliberate Delegate

Deliberate Delegate is a coordination layer for file-based engineering work. It
keeps direct human Phase authorization, file-only execution, immutable evidence,
two-planner judgment, and a stop before merge. A DD Step is one coherent,
bounded Work Package, not each internal checklist item.

This skill is independent of, and uses rather than replaces, upstream
`delegate-skills` provider adapters. Adapters own provider transport and raw
`delegate-relay.result.v1` output; DD owns planning, authorization, records,
review, and gates.

## Role and session contract

- Planning Lead is project-long by default and remains user-facing. A session is
  not the authority record; direct human authorization and immutable records are.
- Planner 2 has Phase-scoped continuity by default for v0.4. A
  fresh-per-package Planner 2 is an experiment, not the recommendation, because
  cache-creation cost is unresolved.
- When Claude is Planner 2, every substantive launch or resume must have an
  effective `--autocompact 400k` setting verified in the dispatch envelope or
  provider evidence before the call. Do not assume a setting from an earlier
  launch persists. If the active adapter cannot pass or verify it, stop and
  report the compatibility gap instead of claiming it is enabled.
- Manual compaction is recovery only: use it in the exact same session when
  automatic compaction actually fails or a concrete context problem appears,
  then record the trigger and result. Never schedule manual compaction merely
  because another review or Work Package is starting.
- Executor is scoped to one Work Package, including its authorized corrections
  and one permitted technical replay. Starting the next package with the same
  approved role holder and a new package session is not role replacement.
- Replacing a role holder requires direct user approval. No session inherits
  authority from identity or history.

## Risk-sensitive review

The Planning Lead proposes one tier in each Work Package brief. Planner 2 may
escalate it unilaterally; a downgrade requires both planners and an immutable
record.

| Tier | Pre-implementation review | Post-implementation review |
| --- | --- | --- |
| `routine` | Lead may dispatch without Planner 2 pre-review | Lead and Planner 2 independent review required |
| `reviewed` | One structured Planner 2 verdict | Lead and Planner 2 independent review required |
| `deliberate` | Independent-first bounded deliberation | Lead and Planner 2 independent review required |

`deliberate` covers architecture, safety, PLC sequences/interlocks,
schema/data migrations, and comparable consequential work. Planner verdicts are
`APPROVE`, `BLOCK`, or `NEEDS_EVIDENCE`. `APPROVE` ends pre-review immediately;
there is no approval echo. A `BLOCK` is delta-focused and names concrete
blockers/acceptance IDs. Silence, timeout, malformed output, or technical
failure is never approval.

## Awaitable execution and evidence

Dispatch once and await the owned job controller's terminal process/result
condition. The normal path contains no model-driven polling, repeated status
prompts, transcript rereads, or approval echoes. If the host cannot suspend the
Lead while waiting, record `suspensionStatus: unavailable` and stop; never fall
back silently to model polling. An awaited Promise or child wait alone records
`unknown`, not `enforced`; `enforced` requires host telemetry proving zero Lead
model turns between dispatch and terminal completion.

The v0.4 release provides:

- `scripts/lib/lifecycle-core.mjs` — shared containment, process capture,
  bounded drain, validation, session mapping, summaries, and correction policy;
- `scripts/lib/job-controller.mjs` — one-dispatch `ProcessJobController` with
  persisted idempotency identity, result-before-exit observation, reconciliation,
  and explicit timeout/process-tree limits;
- `scripts/lib/result-capsule.mjs` — bounded machine-readable capsules with raw
  locators, SHA-256 integrity digests, session/suspension evidence, gate
  coverage, truncation disclosure, and role-scoped status vocabulary.

SHA-256 is an integrity check only when the expected digest is trusted. It is
not a signature, identity proof, or provenance proof. Provider usage is recorded
only when the provider reports it; DD invents no cost, quota, or token claim.

## Correction and recovery boundaries

The Phase configures the correction policy. The backward-compatible default is
two correction attempts; the absolute v0.4 ceiling is three. An executor
cannot raise it. A no-progress attempt with the same blocking defects and no
new relevant evidence stops immediately. A restart treats uncertain work as
`UNKNOWN` until reconciled; a known terminal result is reused without rerunning.
Timeout reports child-only termination unless a platform implementation proves
more. Partial edits remain evidence; DD never runs automatic reset, checkout,
deletion, or cleanup.

## Governing references

Read only the detail needed for the current action:

1. [Workflow](references/workflow.md) — phases, risk review, awaitable dispatch,
   dual review, correction, replay, and stop gates.
2. [Records](references/records.md) — immutable artifacts, the existing
   `docs/deliberate-delegate/phases/<phase>/state.json` path, job/capsule
   pointers, and recovery semantics.
3. [Brief and Result Contract](references/brief-contract.md) — risk tier,
   acceptance criteria, safety capsule, and report schema.
4. [Providers](references/providers.md) — adapter/session mappings and the
   provider-runtime boundary.
5. [Awaiting and Result Capsules](references/suspension.md) — controller,
   suspension, capsule, pilot, and correction details.
6. [Efficiency helper](references/efficiency.md) — optional Lead-side mechanical
   checks and raw-evidence handling.
7. [Optional planning inputs](references/planning-inputs.md) — local-only
   integration of external planning skills.

Plan agreement never authorizes a Phase. The user must directly authorize the
Phase with an explicit scope and completion boundary. A completed Phase stops
at `COMPLETED_PENDING_MERGE` for user review and merge approval.
