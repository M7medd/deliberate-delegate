---
name: deliberate-delegate
description: Durable human-gated multi-agent coordination workflow featuring two persistent planners (Planning Lead and Planner 2) and delegated executor sessions. Provides explicit Phase authorization, immutable deliberation and brief records, independent dual review, mechanical verification gates, and strict correction limits. Excludes and does not replace single-turn one-off delegation, ordinary reviews, or raw CLI provider adapters.
license: MIT
metadata:
  version: 0.2.0
---

# Deliberate Delegate

Deliberate Delegate coordinates structured, human-gated multi-agent workflows for file-based engineering and technical project work using two persistent planners and a fixed delegated executor.

Automatic skill discovery remains enabled by default; this skill adds no explicit-only invocation policy.

Requires Git, two independently addressable planner sessions, and an installed `*-delegate` skill from `delegate-skills` supporting exact session resume.

---

## Attribution and Upstream Relationship

Deliberate Delegate is an independent coordination layer built on top of Ahmed Mohammed's upstream [`delegate-skills`](https://github.com/amElnagdy/delegate-skills).

- **Upstream (`delegate-skills`):** Owns the implementer layer — CLI dispatch, exact session resumption, and the `delegate-relay.result.v1` result contract.
- **Deliberate Delegate:** Adds the coordination layer — two-planner consensus, human Phase authorization, immutable records, dual review, and stop gates.
- **Distinction:** This skill is not an upstream `*-delegate` adapter, is not part of `delegate-skills`, and is not endorsed by upstream authors.

---

## Core Roles and Responsibilities

1. **Planning Lead:** User-facing planner session. Owns communication with the user, Git branch and checkpoint management, immutable artifact recording, and verification checks. Shares equal decision authority with Planner 2. Persistent across the entire project.
2. **Planner 2:** Independent technical peer session. Conducts pre-Step deliberation and independent post-Step dual review. Shares equal decision authority with Planning Lead. Persistent across the entire project.
3. **Executor:** Persistent, resumable delegated worker session executing implementation briefs within the workspace. Does not execute Git commands or make architectural decisions. Persistent across the entire project.

---

## Critical Invariants

1. **Plan Approval Is Not Execution Authorization:** Agreeing upon or loading a project plan does not authorize execution. Every Phase requires an explicit, separate human authorization command defining scope and limits.
2. **Persistent Exact Sessions:** Planner and executor sessions are fixed for the entire project and reused across all Phases. Agent replacement requires explicit user approval. Silence or technical failures never constitute consent.
3. **File-Only Default & Provider-Runtime Boundary (Option A2):** All task deliverables and task-driven changes are strictly confined to the project workspace. Outside the project root, a provider runtime may create or update session-scoped runtime state only inside its documented provider-owned session, scratch, or cache directory when the state belongs to the exact fixed session authorized for this project and its provenance can be verified. Such state may contain only runtime/session transport data, never task deliverables, copied project content, or secrets. Outside-root deletion remains prohibited during unattended execution; a provider that requires deletion must stop the Phase for direct, action-specific user authorization. Accessing credentials, secrets, auth stores, unrelated private files, or another session's runtime state is forbidden. Narrowly necessary reads of installed provider/skill documentation are permitted when allowed by the host. Every outside-root path created or updated must be declared in the executor report (a claim of `none` is not evidence), and any unauthorized outside write or deletion halts the Phase. External network or system actions require direct human presence and explicit approval.
4. **Immutable Records:** Plans, authorizations, briefs, debate transcripts, results, and decisions are immutable once written. Corrections produce new versioned files (`v2`, `v3`), never in-place edits.

---

## Workflow Summary and Reference Routing

Detailed rules and contracts are documented in modular references. Consult the relevant reference before taking action:

1. [Workflow Reference](references/workflow.md)
   *Must be read before initializing a Phase, starting Step deliberation, dispatching briefs, or handling corrections and stop gates.*
   Covers the 12-step governance loop, project-long fixed sessions, two-attempt correction limits, one-retry technical failure policies, Git branch isolation, and stop gates.

2. [Records Reference](references/records.md)
   *Must be read before writing or updating project records, debate transcripts, briefs, or state.json.*
   Covers the `docs/deliberate-delegate/` directory structure, immutable debate formats with visible message preservation, verbatim human authorization schema, and the `state.json` contract.

3. [Providers Reference](references/providers.md)
   *Must be read when configuring or dispatching to upstream delegate adapters.*
   Covers adapter prerequisites, exact session resume arguments (`--session <id>`, `--conversation <id>`), result field mappings, context continuity guidelines, and supported upstream skills.

4. [Brief and Result Contract](references/brief-contract.md)
   *Must be read before writing, reviewing, correcting, or dispatching a Step brief.*
   Defines the mandatory initial and correction brief fields, checkable acceptance criteria, canonical safety capsule, pre-dispatch gate, and Executor Report schema.

5. [Lead Efficiency Helper](references/efficiency.md)
   *Read before using the optional Node helper for snapshots, batched gates, adapter waiting or generated navigation.*
   Keeps raw evidence outside default active context; mechanical PASS never replaces planner approval or the canonical brief.
