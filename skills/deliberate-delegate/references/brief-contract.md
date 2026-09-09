# Deliberate Delegate — Brief and Result Contract

Read this reference when writing, reviewing, correcting, or dispatching a Work Package (Step) brief. A Step is one coherent, bounded outcome with dependency, risk, and verification boundaries; it is not an internal checklist item or ticket. The brief is the immutable, provider-neutral execution contract. Provider CLI details belong to the dispatch envelope, never to its substantive requirements.

## Pre-dispatch Gate

Planning Lead and Planner 2 must agree that every mandatory field is present, internally consistent, and supported by the Phase authorization. For consequential architecture, safety, or scope decisions, the independent-first evidence/question exchange precedes the recommendation-bearing draft brief. The canonical brief and its acceptance-criteria mapping cover the whole Work Package; internal checklist items do not become separate Steps or review records. Acceptance criteria must be individually checkable, verification procedures must be usable, and the safety capsule must match the canonical text below exactly. Once agreed, freeze the exact brief version for dispatch; any substantive finalization change requires renewed planner review and a new immutable version.

Do not dispatch when a mandatory field is missing or contradictory. Do not ask the Executor to infer scope, authority, acceptance, or safety boundaries.

## Initial Step Brief

Every initial brief contains:

1. **Objective and Work Package boundary:** one or two sentences describing the required outcome and its dependency, risk, and verification boundary. An internal checklist may be included as execution detail, but it is not a separate dispatch or record unit.
2. **Authorized scope and exact file allowlist:** the only paths the Executor may create or change.
3. **Acceptance criteria:** identifiers `AC-1` through `AC-n`, each answerable yes or no from a file, diff, or command result.
4. **Verification procedures:** exact runnable commands. When no command exists, record the reason and the explicit mechanical inspection agreed by both planners; an unexplained `none` is invalid.
5. **Safety capsule:** policy identifier `file-only-option-a2` followed by the canonical capsule below, pasted verbatim.
6. **Step-specific boundary additions:** additional restrictions for this Step, or an explicit `none`.
7. **Stop conditions:** missing context, required scope expansion, safety violation, prohibited external effect, or another Step-specific condition that returns control without guessing.
8. **Result contract:** require the Executor Report schema below and list every applicable `AC` identifier.

Add these fields only when their trigger applies:

- **Evidence and current state:** required for every correction; optional for an initial brief when the Executor can inspect all required evidence inside the authorized workspace.
- **Frozen decisions:** required when an earlier Step or planner decision settled something the Executor could plausibly reopen.
- **Non-goals:** required when adjacent work is plausibly attractive but outside scope.
- **Exact work required:** required only when the output shape is contractual, such as fixed names, schemas, or verbatim text. Otherwise preserve the Executor's freedom to choose the implementation approach.

## Correction Brief

A correction creates a new immutable brief version and contains:

1. **Parent brief version** and an instruction to preserve valid prior work and every earlier immutable record.
2. **Correction attempt:** `1 of 2` or `2 of 2`.
3. **Defects:** identifiers `D-1` through `D-n`, each naming the observed failure, target file, and required outcome.
4. **Correction write allowlist:** normally narrower than the parent brief.
5. **Acceptance criteria:** one checkable criterion per defect, reusing the corresponding `D` identifier.
6. **Verification procedures:** exact commands or agreed mechanical inspections for the correction.
7. **Safety capsule:** repeat policy identifier `file-only-option-a2` and the canonical capsule verbatim; do not rely on inherited session context.
8. **Result contract:** require the Executor Report schema and every applicable defect identifier.

When a correction touches files containing already accepted work, include **Frozen decisions** and identify what must remain unchanged. Do not restate the original objective, general non-goals, or implementation method unless the correction changes them within the already authorized Phase scope.

## Executor Report

Require the Executor to return:

1. **Status.**
2. **Files created or changed:** exact project-relative paths.
3. **Criterion results:** one entry for every `AC` or `D` identifier, with `PASS`, `FAIL`, or `NOT_RUN` and a concrete evidence locator such as `file:line` or command plus exit code.
4. **Verification performed:** commands or inspections with outcomes and exit codes where applicable.
5. **Outside-root paths created or updated:** exact declared paths or `none`, explicitly identified as an Executor declaration rather than independent evidence.
6. **Outside-root deletion:** if deletion becomes necessary, report that execution stopped and that no deletion was performed.
7. **Required work not completed:** explicit items; silence never means completion.
8. **Blockers and deviations:** without expanding scope or making new architectural decisions.

The Planning Lead verifies these claims independently. A complete report is not proof that the implementation is correct.

## Canonical Safety Capsule

Copy the following block into every initial and correction brief without paraphrasing:

```text
Safety policy: file-only-option-a2
All task deliverables and task-driven changes must stay inside the authorized project paths. The Executor must not run Git.
Outside the project root, the provider runtime may create or update session-scoped runtime state only inside its documented provider-owned session, scratch, or cache directory when it belongs to the exact fixed session authorized for this project and its provenance can be verified.
Provider runtime state may contain runtime/session transport data only, never task deliverables, copied project content, or secrets. Every outside-root path created or updated must be declared; `none` is a declaration, not independent evidence.
Outside-root deletion is prohibited during unattended execution. If deletion is required for any reason, stop and report the requirement without performing it.
Do not access credentials, secrets, auth stores, unrelated private files, another session's state, or another project's state. Do not install packages or perform external network or system actions beyond configured model transport without direct, action-specific user authorization.
If any required action exceeds these boundaries or the authorized scope, stop without making that change.
```

Step-specific restrictions follow this block and may narrow it. They never broaden it without a new direct user authorization record.
