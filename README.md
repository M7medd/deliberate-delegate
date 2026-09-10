# Deliberate Delegate

> Human-gated multi-agent coordination layer for dual-planner deliberation and delegated execution.

**Current release:** `0.4.0`

Version 0.4.0 adds the awaitable Work Package path, persistent job and
result-capsule evidence, risk-sensitive review, bounded correction policy, and
shared lifecycle mechanics. It does not claim token, cost, quota, or universal
suspension savings without a controlled host-telemetry pilot. See [awaiting and
capsules](skills/deliberate-delegate/references/suspension.md) and [usage and
limits](skills/deliberate-delegate/references/efficiency.md).

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
- An autonomous background daemon or replacement provider execution runtime.
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
5. **Delegated Execution:** The Planning Lead dispatches the brief once to the Work Package-scoped executor via the configured adapter and awaits the owned terminal process/result condition without model-driven polling. Suspension is `unknown` unless host telemetry proves `enforced`; unavailable suspension stops without fallback.
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

The following capabilities remain deferred from the `0.4.0` release:

- Unattended advancement across multiple Phases.
- Automated LLM context compaction and threshold handling.
- Automated provider usage threshold pause (>90% usage guard).
- Windows Job Object process-tree termination unless independently proven.
- Automatic agent replacement or dynamic failover.
- Multi-Phase orchestration pipelines.
- Domain-specific or live hardware adapters.

---

## Disclaimer

Local verification (Git and Node, no packages or model calls):

```powershell
node --test tests/dd-efficiency.test.mjs tests/dd-efficiency-run-index.test.mjs tests/dd-v04.test.mjs
node tests/dd-efficiency-benchmark.mjs
```

Fixtures stay in ignored `tests/.dd-efficiency-scratch/` and `tests/.dd-v04-scratch/`, never live projects.
The benchmark compares identical synthetic checks including failures. Host calls
and visible bytes are not proof of actual token/quota savings; a live A/B is needed.

This is a `0.4.0` specification, instruction skill and optional
mechanical helper. It is not released or production-proven, warranted for
reliability, or endorsed by upstream tool authors.
