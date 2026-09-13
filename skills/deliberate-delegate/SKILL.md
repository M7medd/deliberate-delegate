---
name: deliberate-delegate
description: Human-gated multi-agent coordination with durable project records, risk-sensitive planner review, awaitable Work Package execution, independent dual review, and bounded recovery.
license: MIT
metadata:
  version: 0.6.0
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
- When the confirmed Planner 2 `providerFamily` is `claude`, every substantive
  launch or resume must have exactly one `--autocompact 400k` declaration
  mechanically inspected in the actual dispatch argv before the call. Caller
  context JSON and an adapter name cannot verify it; the inspection proves the
  requested argument only, not provider-side application or enforcement. Do not
  assume a setting from an earlier launch persists. If the active adapter cannot
  pass it, stop and report the compatibility gap instead of claiming it is
  enabled.
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
`unknown`, not `enforced`. The `enforced` value remains readable for legacy
records, but no current controller or capsule-emission API may create it;
legacy structural validation is explicitly non-attested.

Before every planner or executor dispatch, select and record a concrete host
wait path and a valid `dd.adapter-envelope.v1`. The envelope binds the
effective project-relative working directory and either declares
`inherits_process` or a bounded adapter cwd argument/value contract. On Codex, run the adapter through `dd-efficiency.mjs job` inside one
outer orchestration-tool call; keep every process-session wait inside that same
call. Do not let a short shell yield return control to the Lead, and do not emit
Lead-authored progress updates while the delegate is running. Host-side
notifications that do not sample the Lead are allowed. If the host cannot keep
the wait inside one orchestration call, treat suspension as unavailable and
stop before dispatch. Read [Awaiting and Result Capsules](references/suspension.md)
for the exact Codex pattern and evidence limits.

The runtime foundation provides:

- `scripts/dd-runtime.mjs` — dependency-free local CLI for the deterministic
  questionnaire/configuration, scoped immutable human-question queue with one
  atomic terminal transition, scoped session binding/replacement evidence,
  shared Planner 2/Executor dispatch, result acknowledgement, and derived
  next-stop projection;
- `scripts/lib/project-config.mjs` and `scripts/lib/question-queue.mjs` —
  create-once linear configuration-chain records and scoped verbatim
  question/answer/withdrawal records;
- `scripts/lib/runtime-coordinator.mjs` — the non-authoritative coordinator that
  gates dispatch on confirmed configuration, applicable question and scoped
  binding stops, performs mechanical mapped-adapter argv inspection, and records
  result acknowledgement without treating it as approval;
- `scripts/lib/lifecycle-core.mjs` — shared containment, process capture,
  bounded drain, validation, session mapping, summaries, and correction policy;
- `scripts/lib/job-controller.mjs` — one-dispatch `ProcessJobController` with
  persisted idempotency identity, result-before-exit observation, reconciliation,
  and explicit timeout/process-tree limits;
- `scripts/lib/result-capsule.mjs` — bounded machine-readable capsules with raw
  locators, SHA-256 integrity digests, session/suspension evidence, gate
  coverage, truncation disclosure, adapter-envelope declaration evidence, and
  role-scoped status vocabulary. Planner capsules additionally use
  `TRANSPORT_FAILED`; agent self-reports use only substantive planner verdicts.

SHA-256 is an integrity check only when the expected digest is trusted. It is
not a signature, identity proof, or provenance proof. Adapter cwd matching is
string-level declaration/contract evidence, not OS attestation. Provider usage
is recorded only when the provider reports it; DD invents no cost, quota, or
token claim.

The runtime configuration is operational metadata, not authorization. It may
show computed repository/cwd/identity values and preserve human inputs, but it
cannot contain Phase scope, allowlists, acceptance criteria, risk decisions,
validators, safety authority, correction approval, role replacement approval, or
merge/release/push/live-system approval. The runtime returns those decisions to
the Planning Lead or user and never creates a second Phase/Step state machine.
Its `providerFamily` values are closed (`claude`, `codex`, `gemini`, `other`),
and `noCommit` values are non-attesting declarations (`adapter_policy_declared`,
`host_tool_guarded`, `instruction_only`), not OS enforcement proof.
For every dispatch, the active confirmed role profile is the sole source of
adapter, provider family, model, effort, permission, and Executor `noCommit`
values; a differing caller duplicate stops. The per-dispatch envelope carries
  bounded `dd.invocation-contract.v1` metadata that is checked against actual
  argv before launch. Explicit selector evidence is requested-argv evidence;
  Claude Executor's adapter default is `adapter_default` evidence inferred from
  bounded selector absence. Claude Planner 2 requires explicit `--read-only` and
  separated `--autocompact 400k`; Claude Executor's file-only `workspace-write`
  profile uses the mapped relay's normal `acceptEdits` default and proves only
  bounded selector absence. Codex Planner 2 uses explicit `--read-only`, while
  Codex Executor uses explicit `--sandbox workspace-write`. All such evidence
  is limited to requested argv or bounded adapter-parser behavior and never proves provider
  application, OS sandboxing, filesystem containment, or enforcement; a capsule
  uses `requested_argv_only` for explicit-only evidence and
  `requested_argv_and_adapter_default` when both evidence classes are present.

For a user-authorized usage experiment, initialize the usage ledger before the
Lead's first project inspection, take a zero-delta Lead baseline, and capture
each terminal planner/executor attempt—including failures—at the next Work
Package boundary. Use the mechanical recorder linked below; do not ask agents
to reconstruct consumption from memory or load transcripts to calculate it.

## Correction and recovery boundaries

The Phase configures the correction policy. The backward-compatible default is
two correction attempts; the absolute ceiling is three. An executor
cannot raise it. Every dispatch is recorded as `initial`, `correction`, or
`technical_replay`; correction and replay require immutable project-relative
authorization evidence and SHA-256 validation. Corrections use a sequential
ordinal within the configured/absolute ceiling; a technical replay is distinct,
allowed once per Work Package/job, and requires the same immutable identity and
bound session after a qualifying transport failure. The Planning Lead applies
the structured `evaluateCorrection` policy to decide semantic no-progress;
runtime does not infer that judgment from arbitrary authorization text. Binding,
pending, and attempt records are selected numerically only after their connected
chain validates. A restart treats uncertain work as `UNKNOWN` until reconciled;
a known terminal result is reused without rerunning.
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
8. [Usage recorder](scripts/dd-usage.md) — initialize usage evidence before an
   experiment, capture exact role/run sources at Work Package boundaries, and
   generate a compact measured summary without transcript rereads.

Plan agreement never authorizes a Phase. The user must directly authorize the
Phase with an explicit scope and completion boundary. A completed Phase stops
at `COMPLETED_PENDING_MERGE` for user review and merge approval.
