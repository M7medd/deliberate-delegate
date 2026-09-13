# Deliberate Delegate

> Human-gated multi-agent coordination layer for dual-planner deliberation and delegated execution.

**Current release:** `0.6.0`

Version 0.6.0 adds the deterministic Architecture B coordination runtime for
confirmed project configuration, scoped questions, exact session binding,
role-profile and invocation-contract validation, bounded dispatch/recovery,
immutable events, result acknowledgement, and derived next-stop status. It
keeps Phase authorization, semantic planning judgment, session replacement,
and release authority outside the runtime.

Version 0.5.0 hardens the runtime foundation with required project-relative
adapter envelopes, fail-closed cwd validation, normalized dispatch identity,
transport-aware planner results, bounded result capsules, and removal of the
experimental Planner 2 initialization route that did not demonstrate useful
consumption savings.

Version 0.4.2 adds a dependency-free, append-only usage recorder for controlled
experiments. It captures exact Codex rollout and delegate-run sources, prefers
Claude `modelUsage`, records provider rate-limit events when present, includes
failed attempts, and leaves unavailable measurements as `unknown`.

Version 0.4.1 makes Claude Planner 2 auto-compaction a verified preflight
requirement: every substantive launch/resume must enable `--autocompact 400k`.
Manual compaction is reserved for an actual automatic-compaction failure or a
concrete context problem; it is not a routine step.

Version 0.4.0 adds the awaitable Work Package path, persistent job and
result-capsule evidence, risk-sensitive review, bounded correction policy, and
shared lifecycle mechanics. It does not claim token, cost, quota, or universal
suspension savings without a controlled host-telemetry pilot. See [awaiting and
capsules](skills/deliberate-delegate/references/suspension.md) and [usage and
limits](skills/deliberate-delegate/references/efficiency.md).

## Runtime foundation

Version 0.5.0 requires `dd.adapter-envelope.v1`, uses a project-relative
effective cwd, fails closed
when cwd mechanisms are unknown or undeclared, and binds dispatch through
`dd.dispatch-identity.v2`. Planner verdicts are `APPROVE`, `BLOCK`, or
`NEEDS_EVIDENCE`; `TRANSPORT_FAILED` is a controller transport result, not a
planner verdict.

The current controller and result-capsule path cannot emit
`suspensionStatus: enforced`; `enforced` is readable only for legacy structural
validation and is explicitly non-attested. The former deterministic Planner 2
initialization route was removed after the measured experiment did not
demonstrate useful consumption savings. That result is mechanical evidence only,
not a causal explanation or a universal inefficiency claim.

## Version `0.6.0`

Version 0.6.0 adds one deterministic, dependency-free `dd-runtime.mjs` path beneath the
Planning Lead for project configuration, scoped verbatim human questions and
answers, atomic terminal transitions, scoped first-session binding, exact-session
continuation, Planner 2/Executor transport, deterministic artifacts, immutable
events, result acknowledgement, and a derived next-stop projection.
The runtime records evidence and returns required stops; it does not interpret
answers, choose risk or verdicts, authorize work, replace sessions, advance a
Phase, or claim B3 token, quota, cost, or subscription savings.

The runtime requires a confirmed `dd.project-config.v1` record and a
per-dispatch `dd.adapter-envelope.v1`/brief plus bounded `phaseKey` and
`workPackageKey` dispatch context. `planner-2` maps to the existing capsule role
`planner`; bindings are scoped by confirmed continuity policy and a first
provider result with one usable session ID stops at `AWAITING_SESSION_BINDING`
until an explicit confirmer records the immutable `dd.session-binding.v1`
binding. Open or contradictory applicable questions, invalid configuration,
invalid envelopes, unavailable suspension, missing mechanically inspected Claude
Planner 2 `--autocompact 400k` argv, and session contradictions stop before an
unauthorized next launch. Replacement requires immutable path/digest evidence;
it is never automatic.

The v0.6.0 correction path makes the confirmed role profile the sole source of
adapter, provider family, model, effort, permission, and Executor `noCommit`
  values; differing caller duplicates stop before launch. Each dispatch envelope
  carries bounded `dd.invocation-contract.v1` metadata, which is checked against
  the actual argv. Explicit selector evidence is requested-argv evidence; the
  exact Claude Executor default is `adapter_default` evidence inferred from
  bounded selector absence. Capsules use `requested_argv_only` for explicit-
  only evidence and `requested_argv_and_adapter_default` when the latter is
  present; neither meaning proves provider application or enforcement. Attempts are explicitly `initial`, `correction`,
  or `technical_replay`; non-initial kinds require immutable authorization and
  the configured/absolute correction or replay limits. The deterministic runtime
  mappings are role-specific: Claude Planner 2 uses explicit `--read-only` plus
  separated `--autocompact 400k`, while Claude Executor's configured
  `workspace-write` profile uses the measured normal `acceptEdits` adapter
  default, proven only by bounded absence of permission/autonomy selectors.
  Codex Planner 2 uses explicit `--read-only`, and Codex Executor uses explicit
  `--sandbox workspace-write`. Other adapters require a measured capability
  mapping and unknown aliases stop before launch. Conflicting or broader
  selectors are rejected; these evidence labels never prove provider
  application, OS sandboxing, filesystem containment, or no-commit enforcement.
  Binding, pending, and attempt records are ordered numerically, and a
  role/scope binding is usable only after its complete connected chain validates.
  Historical pending records are retained and resolved only by exact binding
  request path/digest references. The Planning Lead owns semantic no-progress
  decisions; runtime enforces immutable authorization, sequencing, and ceilings.

### Local runtime CLI

Run `node skills/deliberate-delegate/scripts/dd-runtime.mjs --help` from the
project root. The CLI covers `questionnaire`, `config`, `question`, `binding`,
`dispatch`, `result acknowledge`, and `status`. Verbatim human text, briefs,
configuration answers, adapter envelopes, context evidence, acknowledgement
evidence, and adapter argv are read from project-relative files. Records are
create-once and bounded; the projection is non-authoritative and does not
recursively guess a historical capsule. `noCommit` values are declared
capability/evidence classes (`adapter_policy_declared`, `host_tool_guarded`, or
`instruction_only`), not OS enforcement attestations. A complete Work Package
still requires the Planning Lead's human/planner gates and independent review.

**Repository:** https://github.com/M7medd/deliberate-delegate

Deliberate Delegate is an instruction skill and documentation package that establishes a structured, human-authorized engineering loop. It coordinates two planners (Planning Lead and Planner 2) overseeing Work Package-scoped, resumable executor sessions across phased file-based project work.

---

## Origin and acknowledgement

Deliberate Delegate is an independent coordination layer built on and requiring Ahmed Mohammed's upstream [`delegate-skills`](https://github.com/amElnagdy/delegate-skills).

### Division of credit

- **Upstream (`delegate-skills` by Ahmed Mohammed / amElnagdy):**
  Owns the implementer layer — dispatching structured briefs to provider command-line interfaces (CLIs), managing exact-session resumption, providing provider-specific adapters, and standardizing the `delegate-relay.result.v1` result contract.
- **Coordination layer (Deliberate Delegate):**
  Adds the multi-agent governance and coordination layer — two planner roles with equal decision authority, mandatory direct human Phase authorization, immutable deliberation and brief records, risk-sensitive Work Package review, awaitable execution, independent dual review following execution, bounded correction policy, and deterministic stop gates.

### Independence and non-endorsement

- Deliberate Delegate does not claim invention of delegated execution.
- Deliberate Delegate is an independent project; it is not an upstream `*-delegate` adapter, is not part of `delegate-skills`, and is not affiliated with or endorsed by Ahmed Mohammed or the upstream `delegate-skills` project.
- This project is not a fork; it vendors no upstream executable or source code and reimplements no relay.
- Users and contributors must direct all issues, feature requests, and support inquiries to [this project's issue tracker](https://github.com/M7medd/deliberate-delegate/issues), not upstream.

---

## What this skill is and is not

### This skill IS:
- A provider-neutral and domain-neutral instruction skill and process specification.
- A human-in-the-loop framework requiring explicit human authorization before executing any project Phase.
- A risk-tiered planner protocol: routine packages use the Lead's mechanical completeness gate, reviewed/deliberate packages receive the required Planner 2 pre-review, and every package receives independent dual post-review. Unanimity remains required for project/Phase plans, risk-tier downgrades, consequential decisions, and post-implementation acceptance.
- A durable record system with immutable transcripts, versioned briefs, and structured state tracking.

### This skill IS NOT:
- An autonomous background daemon, LLM manager, or replacement for provider execution transport.
- A replacement for provider CLIs or upstream `*-delegate` adapters.
- A fork or vendored copy of upstream relay scripts.
- An unmonitored agent workflow with automatic cross-phase execution.

---

## The three roles

1. **Planning Lead (Lead Planner):**
   User-facing planner responsible for interacting with the human user, recording immutable transcripts and briefs, managing Git branches and checkpoint commits, and conducting mechanical verification. Holds equal decision weight with Planner 2 and is project-long by default.
2. **Planner 2 (Review Planner):**
   Independent peer planner responsible for critical analysis, risk-tier review, and post-Work-Package dual review against requirements. Holds equal decision weight with Planning Lead and defaults to Phase-scoped continuity in v0.4.
3. **Executor:**
   Work Package-scoped, resumable delegated worker session executing focused implementation briefs within the project workspace via an installed upstream delegate adapter. The executor does not make architecture decisions, does not run Git commands, and does not interact directly with the user.

Replacing a role holder requires explicit direct human approval. Starting the next
package with the same approved role holder and a new package-scoped Executor
session is not replacement; no session inherits authority from identity or history.

---

## Work Packages (Steps)

A DD Step is one coherent, bounded Work Package with a defined outcome,
dependencies, risk boundary, and verification boundary. It is not an internal
checklist item or ticket. Size packages by outcome, dependency, risk, and
reviewability: one independently verifiable change may be one package; split
when authorization, consequential unresolved decisions, independent risk, or
review context genuinely differs. Do not combine unrelated work merely to make
one large package. The Executor may complete and locally test internal items
under one brief; they do not receive separate planner dispatches, debates,
records, or checkpoints. The normal path is one tier-appropriate pre-package
gate and one independent post-package dual review, with the existing correction
and technical-retry limits retained.

## Phase and Step loop

1. **Project and Phase Planning:** Both planners formulate and agree on a phased project breakdown.
2. **Direct Human Phase Authorization:** The human user reviews the Phase plan and explicitly authorizes execution with clear scope boundaries.
3. **Phase Branch Creation:** The Planning Lead initializes a dedicated Git Phase branch.
4. **Pre-Work-Package Review & Briefing:** The Lead records the risk tier and owns routine-package completeness; Planner 2 joins the structured pre-review for `reviewed` packages and independent-first deliberation for `deliberate` packages. The Lead then records the immutable brief (`brief.v1.md`) under the applicable gate.
5. **Delegated Execution:** The Planning Lead dispatches the brief once to the Work Package-scoped executor via the configured adapter and awaits the owned terminal process/result condition without model-driven polling. On Codex, the adapter and all process-session waits stay inside one outer orchestration-tool call; a raw shell call that yields back to the Lead is not an acceptable wait path. Current controller/capsule APIs emit only `unknown` or `unavailable`; legacy `enforced` records are structurally readable but non-attested, and unavailable suspension stops without fallback.
6. **Lead Mechanical Verification:** The Lead independently inspects raw execution output, full Git status (including untracked and staged files), allowlist adherence, and runs local tests/linters.
7. **Independent Dual Review:** Both planners independently review the relevant file diff and checks for the Work Package against its acceptance criteria; both must explicitly approve to proceed.
8. **Checkpoint or Correction:**
   - *On Approval:* Planning Lead commits an atomic Git checkpoint.
   - *On Correctable Issue:* Planning Lead generates a new versioned brief (`brief.v2.md`) and resumes the Work Package session under the Phase correction policy (default 2, absolute v0.4 ceiling 3; no-progress stops).
9. **Phase Completion & Merge Gate:** Once all Steps are verified and accepted, execution halts for human review and pull request / merge authorization.

---

## File-only default and authorization boundaries

Unattended operations performed during authorized execution are strictly **file-only** within the project directory:

- **Workspace deliverables boundary:** All task deliverables and task-driven project changes remain strictly confined to the project root.
- **Provider-runtime exception (Option A2):** Outside the project root, a provider runtime may create or update session-scoped runtime state only inside its documented provider-owned session, scratch, or cache directory when it belongs to the exact authorized role session for the Work Package and its provenance can be verified.
- **Strict prohibitions outside root:** Provider runtime state may contain only runtime/session transport data, never project deliverables, copied project content, or secrets. Unattended deletion outside the project root is prohibited; if deletion is required, the Phase stops for direct, action-specific user authorization. Accessing credentials, secrets, auth stores, environment keyrings, unrelated private files, or another session's runtime state is strictly forbidden. Narrowly necessary reads of installed provider/skill documentation are permitted when allowed by the host environment.
- **Declaration and verification:** Every outside-root path created or updated by a run must be declared in the executor report (a claim of `none` is not evidence by itself). An unauthorized outside-root write or any outside-root deletion without direct approval is a gate failure and stops the Phase. The Lead reports the limits of host observability.
- **Requiring explicit direct human authorization:** External network operations beyond LLM transport, deployments, package installations, account/credential modifications, purchases, messaging, or interactions with live external systems.

---

## Installation and dependencies

### Prerequisites

- Git
- Two independently addressable planner sessions (e.g. within your primary AI assistant environment)
- An installed upstream delegate skill supporting exact session resumption from `delegate-skills`

### Installing upstream delegate skills

```bash
npx skills add amElnagdy/delegate-skills
```

### Installing Deliberate Delegate

```bash
npx skills add M7medd/deliberate-delegate --skill deliberate-delegate
```

---

## Generic invocation example

```text
User: Use $deliberate-delegate to prepare a reviewed Phase 1 plan for implementing the user authentication service, and wait for my direct authorization before execution.
```

The Planning Lead and Planner 2 will collaborate to create `docs/deliberate-delegate/project-plan.v1.md` and `docs/deliberate-delegate/phases/phase-01/plan.v1.md`. Execution will pause until you provide an explicit authorization command such as:

```text
User: I authorize execution of Phase 01 according to docs/deliberate-delegate/phases/phase-01/plan.v1.md with scope limited to src/auth/ and tests/auth/.
```

---

## Deferred, not implemented

The following capabilities remain deferred from this release and earlier
releases:

- Unattended advancement across multiple Phases.
- Automated cross-provider context-occupancy monitoring. Claude launch
  auto-compaction policy is already present.
- Automated provider usage threshold pause (>90% usage guard).
- Windows Job Object process-tree termination unless independently proven.
- Automatic agent replacement or dynamic failover.
- Multi-Phase orchestration pipelines.
- Domain-specific or live hardware adapters.
- B3 controlled A/B measurement of Lead turns, provider-reported usage, quality,
  or real token/quota/cost savings.
- Bounded evidence/context briefs beyond the minimum runtime inputs.
- C project indexing and PLC/HMI impact slicing.

---

## Disclaimer

Release verification (Node, no packages or model calls):

```powershell
node --test tests/dd-efficiency.test.mjs tests/dd-efficiency-run-index.test.mjs tests/dd-v04.test.mjs tests/dd-usage.test.mjs tests/dd-runtime.test.mjs
node --check skills/deliberate-delegate/scripts/dd-runtime.mjs
node --check skills/deliberate-delegate/scripts/lib/job-controller.mjs
node --check skills/deliberate-delegate/scripts/lib/project-config.mjs
node --check skills/deliberate-delegate/scripts/lib/question-queue.mjs
node --check skills/deliberate-delegate/scripts/lib/result-capsule.mjs
node --check skills/deliberate-delegate/scripts/lib/runtime-coordinator.mjs
node tests/dd-efficiency-benchmark.mjs
```

Fixtures stay in ignored `tests/.dd-efficiency-scratch/`, `tests/.dd-v04-scratch/`,
`tests/.dd-usage-scratch/`, and `tests/.dd-runtime-scratch/`, never live projects.
The correction candidate's verification report records the exact current test
counts and any expected platform skip. Run `quick_validate.py` only when an
already-installed Python interpreter is available; otherwise report it as
`NOT_RUN`.
The benchmark compares identical synthetic checks including failures. Host calls
and visible bytes are not proof of token, quota, cost, or end-to-end savings; a
live A/B with host telemetry is needed.

This is the `0.6.0` specification, instruction skill, and optional mechanical
runtime. It is not production-proven, warranted for reliability, or endorsed by
upstream tool authors.
