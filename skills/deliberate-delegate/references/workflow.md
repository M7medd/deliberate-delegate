# Deliberate Delegate — Workflow Specification

This document defines the 12 lifecycle rules, operational boundaries, and stop gates governing Deliberate Delegate.

---

## 1. Fixed Roles and Equal Decision Authority

- **Planning Lead:** Facilitates user interaction, records immutable transcripts and briefs, manages Git branches and checkpoints, and runs mechanical verification.
- **Planner 2:** Acts as an independent peer reviewer, analyzing proposals and evaluating implementation evidence.
- **Equal Authority:** Both planners hold equal decision weight where the tiered workflow requires them. Unanimous explicit agreement is mandatory for project/Phase plans, risk-tier downgrades, consequential decisions, and post-implementation acceptance. A routine package may be dispatched by the Lead after its mechanical completeness gate; `reviewed` and `deliberate` packages require their specified Planner 2 pre-review.
- **Advisory Subagents:** Any spawned auxiliary or subagent sessions are strictly advisory and cannot alter project leadership or bypass planner consensus.

---

## 2. Role and Session Lifetimes

- The Planning Lead is project-long by default and remains user-facing, but the
  session is not the authority record. Direct human authorization and immutable
  records are authoritative.
- Planner 2 defaults to Phase-scoped continuity for v0.4. Fresh-per-package
  Planner 2 is an experiment, not a recommendation, because cache-creation cost
  is unresolved.
- The Executor session is scoped to one Work Package, including its authorized
  corrections and technical replay. Starting the next package with the same
  approved role holder and a new package session is not replacement.
- Replacing a role holder requires direct human user approval. No session
  inherits authority from identity or history.
- Silence, non-responsiveness, or technical disconnections never constitute
  agreement or consensus.

---

## 3. Phased Planning and Direct Human Authorization

- High-level planning decomposes work into one or more sequential Phases (`phase-01`, `phase-02`, etc.).
- A Project Plan remains deliberately flexible: it records Phase objectives, dependencies, major risks, and human gates without prematurely fixing every Step.
- A Phase Plan is more structured: it records the ordered Steps, dependencies, authorized boundary, and completion criteria. Future Steps may be refined from accepted evidence without expanding the authorized Phase scope.
- Reviewing, discussing, or approving a plan is purely advisory and does **not** grant execution authorization.
- Each individual Phase requires a separate, explicit user command authorizing execution with a defined scope, file allowlist, and completion boundary before any project file is modified.

### Steps are bounded Work Packages

- A **Step** is one coherent, bounded Work Package: a defined outcome with explicit dependency, risk, and verification boundaries. It is not each internal checklist item or ticket.
- Size packages by outcome, dependency, risk, and reviewability rather than quota, an arbitrary file count, or convenience. One independently verifiable change may be one Step.
- Split packages when they need genuinely different authorization, contain a consequential unresolved decision, carry independent risk, or would make review unwieldy. Do not merge unrelated work into one large package.
- The Executor may complete and locally test internal checklist items under the package brief. Those items do not receive separate planner dispatches, debates, immutable records, or checkpoints; the initial dispatch still remains subject to the ordinary correction and technical-retry rules.
- Existing approved fine-grained plans are not regrouped retroactively. Regrouping requires a new immutable plan and the normal planner and user gates for any change to authorized commitments; it does not create a new lifecycle state or migration.

---

## 4. Phase Branch and Git Isolation

- Upon receiving direct human Phase authorization, the Planning Lead creates a dedicated Git branch (e.g. `deliberate-delegate/phase-01`).
- The Executor is strictly prohibited from running Git commands (`git commit`, `git checkout`, `git branch`, etc.).
- The Planning Lead owns the baseline comparison, enforces the file allowlist, executes mechanical verification, and creates one atomic checkpoint commit per accepted Step.

---

## 5. Pre-Step Review and Deliberation

- Prior to every Work Package (Step), the Planning Lead examines current evidence, test outputs, and requirements relevant to that package and records the proposed risk tier. Planner 2 joins the pre-step review only when required by that tier or when escalating it. Keep governing rules and active references available; do not reload the entire archive by default.
- The Lead proposes one risk tier: `routine`, `reviewed`, or `deliberate`.
  `routine` may dispatch without Planner 2 pre-review; `reviewed` requires one
  structured Planner 2 verdict; `deliberate` requires independent-first bounded
  deliberation. Planner 2 may escalate unilaterally. A downgrade requires both
  planners and an immutable record. Every tier still requires Lead + Planner 2
  independent post-implementation review.
- For `reviewed` package decisions, the Lead shares the canonical draft brief
  with Planner 2 in one substantive pre-package review so scope, acceptance
  criteria, completeness, and the proposed approach are checked together.
  Internal checklist items are not separate review units.
- For decisions that can materially change architecture, safety, or scope, the independent-first order takes precedence: Planning Lead first sends the shared evidence and question without a recommendation, Planner 2 records an independent first-pass position, and only then does the Lead present its recommendation and draft brief. Routine implementation details do not require this extra round.
- For `reviewed` and `deliberate` packages, the participating planners examine the technical approach, edge cases, verification requirements, and file scope. The structured verdict vocabulary is `APPROVE | BLOCK | NEEDS_EVIDENCE`.
- `APPROVE` ends pre-review immediately; do not generate an approval echo or redundant synthesis message. `BLOCK` identifies concrete blockers and affected acceptance IDs, and the next review is delta-focused. `NEEDS_EVIDENCE` names the missing evidence.
- Concrete blockers trigger bounded follow-up or correction; silence, timeout, malformed output, or technical failure is never approval.
- After the required tier gate, the Planning Lead writes an immutable versioned brief (`brief.v1.md`) conforming to [the Brief and Result Contract](brief-contract.md). A `reviewed` or `deliberate` package also records the applicable pre-review transcript (`debate.pre.v1.md`); a routine package records the Lead's mechanical gate evidence. All visible planner messages are preserved verbatim in chronological order without recording private hidden chain-of-thought.
- The Lead owns the completeness and dispatch gate for routine packages. For `reviewed` and `deliberate` packages, both planners check the mandatory-field completeness, internal consistency, checkable criteria, usable verification, exact safety-capsule text, and Phase-authorization compliance required by their tier. Once the applicable gate passes, the exact brief version is frozen for dispatch. Any substantive finalization change requires the tier-required renewed review and a new immutable version; it must not be rewritten after that gate. Any failure stops dispatch until a valid new brief version exists.

---

## 6. Delegated Execution

- The Planning Lead dispatches the immutable brief once through the configured
  upstream delegate adapter (from `delegate-skills`) into the Work Package's
  Executor session. The awaitable `ProcessJobController` persists identity
  before spawning and resolves on the terminal owned-process/result condition.
- The normal path has no model-driven polling, repeated status prompts,
  transcript rereads, or approval echoes. If host suspension is unavailable,
  record `suspensionStatus: unavailable` and stop; never silently resume model
  polling. Without explicit host telemetry proving zero Lead sampled turns,
  record `unknown`, not `enforced`.
- A raw adapter call that may yield back to the Planning Lead is not an
  acceptable wait path. On Codex, the Lead must use the single-outer-call
  pattern in [Awaiting and Result Capsules](suspension.md): the outer
  orchestration call launches `dd-efficiency.mjs job` and drains any returned
  process session internally until terminal. No Lead message or new Lead tool
  decision occurs between dispatch and terminal result.
- The normal path has one initial package dispatch. If review identifies a correctable defect or transport failure occurs, the existing correction and single technical-replay rules remain in force.
- By default, all operations are file-only within the project workspace directory.

---

## 7. Independent Mechanical Verification

Before the first applicable check or dispatch, the Lead reads the [efficiency helper](efficiency.md) guidance and either uses a compatible batched helper or records the concrete incompatibility and equivalent check coverage. The helper is optional and native in-process delegation need not be wrapped in its CLI `run` command. Executor's no-Git rule remains intact. Read summaries first, then relevant raw evidence; compact summaries never replace evidence. Missing coverage is not proof, and neither planner's independent review is replaced.

- The Planning Lead independently inspects raw execution output, full Git status (including modified, staged, unstaged, and untracked files), allowlist compliance, and executes local automated tests and linters.
- Git status and diffs cover workspace state only. The Executor must declare every outside-root path created or updated during the dispatch; a report claiming `none` is an unverified claim, not evidence.
- The Planning Lead compares executor declarations against provider and runtime evidence available to the host, but must not claim complete outside-root observability when it does not exist.
- Self-reported claims or summaries by the Executor are never accepted as verification evidence; only concrete diffs and tool outputs are valid evidence.

---

## 8. Independent Dual Review

- Planning Lead and Planner 2 independently evaluate the implementation diff and verification outputs against the step requirements.
- The normal successful path has one independent post-package dual review of the actual relevant diff and checks, not merely an Executor summary and not a separate review for each internal checklist item.
- Both planners record their evaluations in `debate.post.v1.md`, capturing all visible review messages verbatim.
- Advancement to the next Step occurs only when both planners explicitly approve the Step and all mechanical gates pass.

---

## 9. Correction Lifecycle and Limits

Correction review uses parent decision/evidence references, defect IDs, the
correction diff, affected criteria and regression outputs. Reviewers may expand
inspection within authorized read scope when justified; that does not grant new
write scope. Contradictions reopen affected findings; narrow corrections need
not reread every original source. Full briefs, the exact safety capsule, visible
debates and both explicit planner approvals remain required.

- If the implementation has correctable defects, omissions, or failing tests, the planners deliberate on the required fixes. The Phase supplies `maxCorrections`; the backward-compatible default is two and the absolute v0.4 ceiling is three. The Executor cannot raise or replace this policy.
- A no-progress attempt means the same blocking defect remains without new relevant evidence or a meaningful delta; stop with `STOPPED_NO_PROGRESS` instead of consuming another correction.
- The Planning Lead creates a new immutable correction brief version (`brief.v2.md`) conforming to [the Brief and Result Contract](brief-contract.md) and dispatches it to resume the same Work Package Executor session.
- The default permits two correction attempts (initial brief plus up to 2 corrections). A configured policy may be lower or, up to the absolute ceiling, higher; a third required correction under the default policy halts the Phase.

---

## 10. Technical Failure and Replay Policy

- Transient transport failures, CLI timeouts, or network interruptions during model transport may trigger at most **one** technical replay (`retry 0..1`) of the exact identical immutable brief to the same resumable session.
- A technical replay is not a correction and does not consume a correction attempt.
- A nontransient exhausted quota, authentication, or budget failure is not blindly replayed unchanged. Before the single replay, require evidence that the relevant condition is resolved and reconcile any prior partial work; otherwise stop and escalate.
- `technicalRetryCount` resets to `0` only when a new immutable brief version becomes active. Replaying the same brief does not reset `technicalRetryCount`.
- A second consecutive technical failure on the same brief version, or a corrupted/non-resumable session, immediately stops the Phase and escalates to the user.
- After restart, uncertain work is `UNKNOWN` until reconciled. A known terminal
  result with a trusted matching idempotency key is reused and does not rerun
  the worker. Never retry while a prior process may still write.

---

## 11. Stop Gates and Scope Refinement

- Any unresolvable failure, gate failure, or exceeded limit immediately halts the Phase.
- A missing or contradictory mandatory brief field, an uncheckable acceptance criterion, an unusable verification procedure, or a non-canonical safety capsule blocks dispatch.
- Future Steps within the active Phase may be refined based on accepted evidence from completed Steps, provided the work stays strictly within the authorized Phase scope.
- Any scope expansion beyond the authorized boundary requires pausing execution and obtaining new direct authorization from the user.

---

## 12. Phase Completion and Merge Gate

- When all Steps in a Phase are verified and accepted, the Phase lifecycle transitions to `COMPLETED_PENDING_MERGE`.
- Execution halts completely. The Planning Lead presents the completed work, test evidence, and diff to the user.
- The next Phase cannot begin until the user reviews the completed Phase, approves the merge, and provides a fresh direct authorization for the subsequent Phase.

---

## File-Only Boundary and User Presence

During unattended Phase execution:
- **Workspace deliverables boundary:** All task deliverables and task-driven project changes remain strictly confined to the project workspace root. Permitted operations include modifying workspace files, running local tests, executing local linters/compilers, and Lead Git branch/checkpoint operations.
- **Provider-runtime exception (Option A2):** Outside the project root, a provider runtime may create or update session-scoped runtime state only inside its documented provider-owned session, scratch, or cache directory when the state belongs to the exact authorized role session for the Work Package and its provenance can be verified.
- **Prohibitions outside root:** Provider runtime state may contain only runtime/session transport data, never task deliverables, copied project content, or secrets. Outside-root deletion remains prohibited during unattended execution; if the provider requires deletion for cleanup, compaction, or any other reason, the Phase stops for direct, action-specific user authorization. Accessing credentials, secrets, auth stores, environment keyrings, unrelated private files, or another session's runtime state is strictly forbidden. Narrowly necessary reads of installed provider/skill documentation are permitted when allowed by the host environment.
- **Outside-root declaration & gate failure:** The executor must declare every outside-root path created or updated in its report (a claim of `none` is an unverified claim, not evidence). The Lead verifies exact-session provenance with available host evidence and reports the limits of that evidence. Any unauthorized outside-root write or any outside-root deletion without direct approval constitutes a mechanical gate failure and immediately stops the Phase.
- **External Effects:** Any actions involving external network calls (outside configured LLM transport), cloud deployments, infrastructure modifications, package installations, account updates, financial transactions, communications, or live-system actuators require direct user presence and explicit, action-specific user authorization.

---

## Deferred Items

The following items are deferred from this MVP specification:
- Automated context compaction and token threshold monitoring.
- Automated provider usage threshold pause (>90% usage guard).
- Advanced subprocess-tree monitoring and hard process kill enforcement.
- Dynamic agent replacement and automated failover.
- Multi-Phase autonomous sequencing pipelines.
- Domain-specific or live hardware adapters.
