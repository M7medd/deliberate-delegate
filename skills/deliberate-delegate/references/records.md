# Deliberate Delegate — Durable Records Specification

This document specifies the file structure, immutability rules, schema definitions, and authorization records used by Deliberate Delegate.

---

## Record Directory Layout

All records are rooted by default at `docs/deliberate-delegate/` in the user's project workspace:

```text
docs/deliberate-delegate/
  project-plan.v1.md
  phases/phase-01/
    authorization.v1.md
    plan.v1.md
    state.json
    steps/step-01/
      debate.pre.v1.md
      brief.v1.md
      result.v1.json
      raw/attempt-01/...
      job.v1.json
      capsule.v1.json
      debate.post.v1.md
      decision.v1.md
```

A `Step` directory represents one coherent, bounded Work Package, not each
internal checklist item or ticket. Package boundaries are based on outcome,
dependency, risk, and verification; a single independently verifiable change
may be one Step. Existing approved fine-grained plans are not regrouped by
reinterpretation. Regrouping requires a new immutable plan and the normal
planner and user gates for any changed authorized commitments. This semantic
clarification adds no lifecycle state and requires no migration.

---

## Immutability and Versioning Rules

For new executions, raw adapter/gate output may live in a fresh `raw/attempt-NN/`
subtree. Preserve existing records and original adapter results unchanged.
Visible transcripts are stored once as immutable raw records and referenced by
path plus SHA-256 digest; they are not loaded into active context by default.
The [efficiency helper](efficiency.md) provides optional generated navigation;
load relevant evidence on demand, not every transcript and raw log each turn.

1. **Strict Immutability:** Once written and agreed upon, plans, authorizations, briefs, debate transcripts, raw execution results, and decision files must never be edited in place.
2. **Version Increments:** Any revisions, refinements, or corrections must be written to new versioned files (e.g. `brief.v2.md`, `debate.pre.v2.md`, `result.v2.json`, `decision.v2.md`).
3. **Full Verbatim Visible Transcripts:** Debate records (`debate.pre.vN.md`, `debate.post.vN.md`) must preserve every visible message exchanged between Planning Lead and Planner 2 verbatim, including role attribution and message sequence. Summaries, paraphrasing, or omissions of visible messages are prohibited. This requirement applies strictly to visible conversation messages; it does not request, capture, or record private hidden reasoning, model scratchpads, or internal chain-of-thought.
4. **Raw Result Preservation:** The raw execution output returned by the upstream delegate adapter must be preserved unaltered as `result.vN.json`.

---

## The `state.json` Contract

`state.json` is the sole mutable workflow-state record in
`docs/deliberate-delegate/phases/<phase>/`. It tracks progress and active
artifact references, but is **not** a source of authority. Job records and
result capsules are evidence/pointers for a Work Package; they do not create a
competing Phase/Step state machine. An explicitly generated non-authoritative
index may also be regenerated; it is a navigation aid, not a workflow record or
authorization. Do not migrate this authority path to `.deliberate/state.json`.

### Authority and Recovery Invariants
- Authority derives exclusively from direct human authorization records and recorded immutable artifacts. `state.json` can point to authorization, but cannot create or alter it.
- A state value alone cannot authorize dispatch, acceptance, correction, retry, merge, or a session change; every transition requires its corresponding immutable artifact and gate evidence.
- Git commit history provides evidence of file modifications, but does not grant authorization.
- Every Phase `state.json` records the approved Planning Lead identity, the
  Phase-scoped Planner 2 identity/continuity, and the current Work Package
  Executor identity. Starting another package with the same approved role
  holder and a new package-scoped Executor session is not replacement. Replacing
  a role holder still requires an explicit, direct user-approved record.
- If `state.json` is missing, corrupt, or contradicts immutable records on disk, execution must immediately stop for user intervention.

### Lifecycle States

Keeping `phaseState` separate from `stepState` prevents a restart from dispatching the same Step twice or mistaking a completed Step for authorization to advance the Phase.

#### Phase Lifecycle States (`phaseState`)
- `PLANNED`: Phase plan drafted and agreed by planners, awaiting human authorization.
- `AUTHORIZED`: Direct human authorization recorded, branch created, ready for step execution.
- `IN_PROGRESS`: Step execution currently underway.
- `STOPPED_CORRECTION_LIMIT`: Halted due to exceeding the Phase-configured correction attempts.
- `STOPPED_NO_PROGRESS`: Halted because the same blocking defect remained without relevant evidence or a meaningful delta.
- `STOPPED_TECHNICAL_FAILURE`: Halted due to repeated technical failures or lost session.
- `STOPPED_GATE_FAILURE`: Halted due to unrecoverable gate or test failure.
- `STOPPED_USER_INTERVENTION`: Halted manually or awaiting user clarification.
- `COMPLETED_PENDING_MERGE`: All steps accepted; halted awaiting human review and merge.
- `MERGED`: Phase branch merged into main target branch.

#### Step Lifecycle States (`stepState`)
- `PENDING_DELIBERATION`: Awaiting the pre-step review required by the Work Package risk tier: Lead mechanical completeness for `routine`, one structured Planner 2 verdict for `reviewed`, or independent-first Planner 2 deliberation for `deliberate`.
- `BRIEFED`: The tier-required pre-step gate concluded; the versioned brief was written.
- `DISPATCHED`: Brief dispatched to executor; awaiting execution result.
- `VERIFYING`: Raw results received; Lead running mechanical checks.
- `DUAL_REVIEW`: Mechanical checks passed; planners conducting independent reviews.
- `ACCEPTED`: Step approved by both planners; checkpoint committed.
- `CORRECTION_REQUIRED`: Review identified issues; preparing next versioned brief.
- `TECHNICAL_RETRY_PENDING`: Transport/timeout issue; preparing single identical replay.
- `STOPPED`: Step execution halted due to failure or limit breach.

### `state.json` Schema Example

```json
{
  "schemaVersion": "1.0.0",
  "phaseId": "phase-01",
  "phaseState": "IN_PROGRESS",
  "phaseBranch": "deliberate-delegate/phase-01",
  "currentStepId": "step-01",
  "stepState": "DISPATCHED",
  "sessions": {
    "planningLead": "lead-session-uuid-001",
    "planner2": "planner2-session-uuid-002",
    "executor": "executor-session-uuid-003",
    "planner2Continuity": "phase-scoped",
    "executorContinuity": "work-package-scoped"
  },
  "executionProfile": {
    "adapter": "agy-delegate",
    "model": "provider-model-label",
    "effort": "high",
    "resumeMode": "exact_session",
    "timeout": "30m",
    "budget": null,
    "permissionProfile": "provider-specific-profile",
    "noCommit": "instruction_only",
    "providerFlags": [],
    "briefContractVersion": "1.0.0",
    "safetyPolicyId": "file-only-option-a2",
    "outsideRuntimePathsDeclared": []
  },
  "contextManagement": {
    "authoritative": false,
    "capability": "provider_native_manual",
    "thresholdPolicy": {
      "occupancyPercent": 40,
      "targetWindowTokens": 1000000,
      "targetCompactionTokens": 400000
    },
    "observedOccupancy": {
      "platform": "Windows",
      "providerVersion": "Claude Code 2.1.267",
      "observedOn": "2026-09-10",
      "reportedAfterCompaction": "56.4k/400k (14%)"
    },
    "compactMethod": "provider-native in-place manual",
    "compactResult": "reported",
    "adapterFlagAvailable": false
  },
  "activeArtifacts": {
    "authorization": "phases/phase-01/authorization.v1.md",
    "phasePlan": "phases/phase-01/plan.v1.md",
    "currentBrief": "phases/phase-01/steps/step-01/brief.v1.md",
    "currentResult": "phases/phase-01/steps/step-01/result.v1.json",
    "currentJob": "phases/phase-01/steps/step-01/raw/attempt-01/job.v1.json",
    "currentCapsule": "phases/phase-01/steps/step-01/raw/attempt-01/capsule.v1.json"
  },
  "correctionAttempt": 0,
  "correctionPolicy": {
    "maxCorrections": 2,
    "absoluteCeiling": 3,
    "configuredBy": "phase"
  },
  "technicalRetryCount": 0,
  "lastCheckpointCommit": "a1b2c3d4e5f678901234567890abcdef12345678",
  "gateVerdicts": {
    "mechanicalVerification": "PASSED",
    "plannerDualReview": "PENDING"
  }
}
```

### Key Field Contracts

- `executionProfile`: Records the actual non-secret dispatch envelope: adapter, model label, effort, exact-session resume mode, timeout, optional budget metadata if any, permission profile, declared `noCommit` mode (`transport_enforced`, `tool_guarded`, or `instruction_only`), non-secret provider flags, brief-contract version, safety-policy identifier, and `outsideRuntimePathsDeclared`. The envelope may adapt transport mechanics but must never change the canonical brief's objective, scope, acceptance criteria, verification procedures, safety capsule, or result contract. A budget entry records an actual inherited or user-specified limit; it is not an automatic dollar cap.
- `contextManagement`: A non-authoritative evidence envelope. Record the capability classification (`adapter_flag`, `provider_native_manual`, or `unsupported`), threshold policy, target window/compaction target, observed occupancy when available, compact method/result, and whether an adapter flag was available. Unknown provider metrics remain `unknown`. Context occupancy and compaction are separate from five-hour subscription usage or quota.
- `outsideRuntimePathsDeclared`: List of paths created or updated outside the workspace root as reported by the executor. This is an executor declaration/claim, not independent proof. Under Option A2, every path must belong to the exact authorized role session for the Work Package, remain inside the provider's documented session/scratch/cache area, and contain runtime/session transport state only. Any undeclared or unauthorized outside write, or any outside-root deletion without direct action-specific user approval, constitutes a mechanical gate failure.
- `correctionAttempt`: Integer from `0` through the Phase-configured
  `correctionPolicy.maxCorrections`; the absolute v0.4 ceiling is `3`.
  Increments on each corrective brief version dispatched. The Executor cannot
  raise or replace the policy. A no-progress attempt stops before dispatch.
- `technicalRetryCount`: Integer (`0..1`). Replaying the same immutable brief version for technical transport failure does not reset this counter and does not consume a correction. It resets to `0` only when a new immutable brief version becomes active.

### Job and capsule recovery

Persist the job identity and idempotency key before dispatch. A verified
terminal capsule is reusable evidence for the same key and must not rerun the
worker. A job record without a verified terminal capsule is `UNKNOWN` after a
restart until reconciled; it is never assumed successful and is never safely
retried while the prior process may still write. A raw result without its
matching job/capsule record is stale. The capsule records raw locators and
SHA-256 integrity digests, but a digest is not a signature or provenance proof.

### Security and Secret Invariant
`state.json` and all Markdown records must **never** store passwords, API keys, tokens, auth cookies, credentials, or private configuration secrets.

---

## Direct User Authorization Record (`authorization.v1.md`)

Direct human authorization must be captured verbatim in `phases/phase-NN/authorization.v1.md`. It must contain:

1. **Timestamp:** ISO 8601 UTC timestamp of authorization.
2. **Authorized Prompt:** Verbatim text of the user prompt granting execution authority.
3. **Phase Identification:** Target Phase ID and primary objective.
4. **Scope and Allowlist:** Explicit list of permitted directories, files, or modules.
5. **Explicit Prohibitions:** Boundaries, forbidden tools, or off-limit files.
6. **Completion Boundary:** Concrete definition of when the Phase is finished.

A project plan or `state.json` file may reference `authorization.v1.md`, but execution must never commence without this immutable record present and recorded.
