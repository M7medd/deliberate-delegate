# Deliberate Delegate — Workflow Specification

This document defines the 12 lifecycle rules, operational boundaries, and stop gates governing Deliberate Delegate.

---

## 1. Fixed Roles and Equal Decision Authority

- **Planning Lead:** Facilitates user interaction, records immutable transcripts and briefs, manages Git branches and checkpoints, and runs mechanical verification.
- **Planner 2:** Acts as an independent peer reviewer, analyzing proposals and evaluating implementation evidence.
- **Equal Authority:** Both planners hold equal decision weight on plans, step scopes, and acceptance. Neither planner may overrule the other. Unanimous explicit agreement is mandatory to proceed.
- **Advisory Subagents:** Any spawned auxiliary or subagent sessions are strictly advisory and cannot alter project leadership or bypass planner consensus.

---

## 2. Persistent Exact Sessions

- The Planning Lead, Planner 2, and Executor must maintain persistent, addressable session identities throughout the entire project. Each Phase reuses these fixed sessions.
- Replacing any agent session requires direct human user approval.
- Silence, non-responsiveness, or technical disconnections never constitute agreement or consensus.

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

## 5. Pre-Step Deliberation

- Prior to every Work Package (Step), Planning Lead and Planner 2 examine current evidence, test outputs, and requirements relevant to that package. Keep governing rules and active references available; do not reload the entire archive by default.
- For routine package decisions, the Lead shares the canonical draft brief with Planner 2 in this substantive pre-package review so scope, acceptance criteria, completeness, and the proposed approach are checked together. Internal checklist items are not separate review units.
- For decisions that can materially change architecture, safety, or scope, the independent-first order takes precedence: Planning Lead first sends the shared evidence and question without a recommendation, Planner 2 records an independent first-pass position, and only then does the Lead present its recommendation and draft brief. Routine implementation details do not require this extra round.
- Both planners debate the technical approach, edge cases, verification requirements, and file scope.
- Concrete blockers trigger bounded follow-up or correction; after clear approval, do not add repetitive approval or synthesis confirmations.
- When both planners explicitly agree, the Planning Lead writes an immutable versioned brief (`brief.v1.md`) conforming to [the Brief and Result Contract](brief-contract.md) and a pre-debate transcript (`debate.pre.v1.md`). All visible planner messages are preserved verbatim in chronological order without recording private hidden chain-of-thought.
- The completeness and dispatch gate is part of this pre-package review: both planners check mandatory-field completeness, internal consistency, checkable criteria, usable verification, exact safety-capsule text, and Phase-authorization compliance. Once agreed, the exact brief version is frozen for dispatch. Any substantive finalization change requires renewed planner review and a new immutable version; it must not be rewritten after consensus without that gate. Any failure stops dispatch until a valid new brief version exists.

---

## 6. Delegated Execution

- The Planning Lead dispatches the immutable brief through the configured upstream delegate adapter (from `delegate-skills`) into the fixed Executor session.
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

- If the implementation has correctable defects, omissions, or failing tests, the planners deliberate on the required fixes.
- The Planning Lead creates a new immutable correction brief version (`brief.v2.md`) conforming to [the Brief and Result Contract](brief-contract.md) and dispatches it to resume the same Executor session.
- A maximum of two correction attempts are permitted per Step (initial brief + up to 2 corrections = max 3 total dispatches).
- If a third correction is required, the Phase immediately halts, records the failure, and returns control to the user.

---

## 10. Technical Failure and Replay Policy

- Transient transport failures, CLI timeouts, or network interruptions during model transport may trigger at most **one** technical replay (`retry 0..1`) of the exact identical immutable brief to the same resumable session.
- A technical replay is not a correction and does not consume a correction attempt.
- A nontransient exhausted quota, authentication, or budget failure is not blindly replayed unchanged. Before the single replay, require evidence that the relevant condition is resolved and reconcile any prior partial work; otherwise stop and escalate.
- `technicalRetryCount` resets to `0` only when a new immutable brief version becomes active. Replaying the same brief does not reset `technicalRetryCount`.
- A second consecutive technical failure on the same brief version, or a corrupted/non-resumable session, immediately stops the Phase and escalates to the user.

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
- **Provider-runtime exception (Option A2):** Outside the project root, a provider runtime may create or update session-scoped runtime state only inside its documented provider-owned session, scratch, or cache directory when the state belongs to the exact fixed session authorized for the project and its provenance can be verified.
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
