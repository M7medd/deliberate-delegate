# Deliberate Delegate

> Human-gated multi-agent coordination layer for dual-planner deliberation and delegated execution.

**Status:** `0.1.0 Public MVP`

**Repository:** https://github.com/M7medd/deliberate-delegate

Deliberate Delegate is an instruction skill and documentation package that establishes a structured, human-authorized engineering loop. It coordinates two collaborating planners (Planning Lead and Planner 2) overseeing a fixed, resumable executor session across phased file-based project work.

---

## Origin and acknowledgement

Deliberate Delegate is an independent coordination layer built on and requiring Ahmed Mohammed's upstream [`delegate-skills`](https://github.com/amElnagdy/delegate-skills).

### Division of credit

- **Upstream (`delegate-skills` by Ahmed Mohammed / amElnagdy):**
  Owns the implementer layer — dispatching structured briefs to provider command-line interfaces (CLIs), managing exact-session resumption, providing provider-specific adapters, and standardizing the `delegate-relay.result.v1` result contract.
- **Coordination layer (Deliberate Delegate):**
  Adds the multi-agent governance and coordination layer — fixed two-planner roles with equal decision authority, mandatory direct human Phase authorization, immutable deliberation and brief records, per-Step deliberation before dispatch, independent dual review following execution, strict correction limits, and deterministic stop gates.

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
- A dual-planner protocol requiring unanimous planner consensus on briefs and dual independent review of file diffs and project deliverables.
- A durable record system with immutable transcripts, versioned briefs, and structured state tracking.

### This skill IS NOT:
- An autonomous background daemon or execution runtime binary.
- A replacement for provider CLIs or upstream `*-delegate` adapters.
- A fork or vendored copy of upstream relay scripts.
- An unmonitored agent workflow with automatic cross-phase execution.

---

## The three fixed roles

1. **Planning Lead (Lead Planner):**
   User-facing planner responsible for interacting with the human user, recording immutable transcripts and briefs, managing Git branches and checkpoint commits, and conducting mechanical verification. Holds equal decision weight with Planner 2. Persistent across the entire project.
2. **Planner 2 (Review Planner):**
   Independent peer planner responsible for critical analysis, pre-Step deliberation, and post-Step dual review against requirements. Holds equal decision weight with Planning Lead. Persistent across the entire project.
3. **Executor:**
   Fixed, resumable delegated worker session executing focused implementation briefs within the project workspace via an installed upstream delegate adapter. The executor does not make architecture decisions, does not run Git commands, and does not interact directly with the user. Persistent across the entire project.

*Note:* Session identities for all three roles remain fixed throughout the project and are reused across all Phases. Replacing any session requires explicit direct human approval.

---

## Phase and Step loop

1. **Project and Phase Planning:** Both planners formulate and agree on a phased project breakdown.
2. **Direct Human Phase Authorization:** The human user reviews the Phase plan and explicitly authorizes execution with clear scope boundaries.
3. **Phase Branch Creation:** The Planning Lead initializes a dedicated Git Phase branch.
4. **Pre-Step Deliberation & Briefing:** Both planners examine current workspace evidence and debate requirements; upon unanimous agreement, the Lead records an immutable brief (`brief.v1.md`).
5. **Delegated Execution:** The Planning Lead dispatches the brief to the fixed executor session via the configured upstream delegate adapter.
6. **Lead Mechanical Verification:** The Lead independently inspects raw execution output, full Git status (including untracked and staged files), allowlist adherence, and runs local tests/linters.
7. **Independent Dual Review:** Both planners independently review the file diff and deliverables against acceptance criteria; both must explicitly approve to proceed.
8. **Checkpoint or Correction:**
   - *On Approval:* Planning Lead commits an atomic Git checkpoint.
   - *On Correctable Issue:* Planning Lead generates a new versioned brief (`brief.v2.md`) and resumes the same executor session (maximum 2 correction attempts per Step).
9. **Phase Completion & Merge Gate:** Once all Steps are verified and accepted, execution halts for human review and pull request / merge authorization.

---

## File-only default and authorization boundaries

Unattended operations performed during authorized execution are strictly **file-only** within the project directory:

- **Workspace deliverables boundary:** All task deliverables and task-driven project changes remain strictly confined to the project root.
- **Provider-runtime exception (Option A2):** Outside the project root, a provider runtime may create or update session-scoped runtime state only inside its documented provider-owned session, scratch, or cache directory when it belongs to the exact fixed session authorized for the project and its provenance can be verified.
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

The following capabilities are intentionally deferred from the `0.1.0 MVP` and will be considered in future releases:

- Unattended advancement across multiple Phases.
- Automated LLM context compaction and threshold handling.
- Automated provider usage threshold pause (>90% usage guard).
- Advanced subprocess-tree monitoring and hard process termination.
- Automatic agent replacement or dynamic failover.
- Multi-Phase orchestration pipelines.
- Domain-specific or live hardware adapters.

---

## Disclaimer

This is a public `0.1.0 MVP` specification and instruction skill. It is not production-proven, warranted for reliability, or endorsed by upstream tool authors.
