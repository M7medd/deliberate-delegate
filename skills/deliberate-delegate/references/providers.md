# Deliberate Delegate — Provider Adapter Contract

This document defines the transport adapter contract for delegating execution from Deliberate Delegate to upstream provider CLI adapters provided by [`delegate-skills`](https://github.com/amElnagdy/delegate-skills).

---

## Upstream Metadata

```yaml
upstream_repository: https://github.com/amElnagdy/delegate-skills
installed_skill_versions_tested:
  claude-delegate: 0.5.0
  codex-delegate: 0.5.0
  agy-delegate: 0.5.0
result_contract: delegate-relay.result.v1
code_vendored: false
licence_verified: 2026-09-01
```

---

## Transport Adapter Contract

Deliberate Delegate coordinates multi-agent planning and relies on upstream `*-delegate` skills for execution dispatch. To be eligible for a fixed executor role, a provider adapter must satisfy the following contract:

1. **Install and Authentication Verification:**
   The adapter or skill must support verifying that the underlying provider CLI tool is installed and authenticated prior to dispatch.

2. **Dispatch Command:**
   Execution is triggered by invoking the respective upstream delegate command owned by the installed skill.

3. **Exact Session Resumption:**
   The adapter must support resuming an exact existing session by identifier (e.g. `--session <id>` or `--conversation <id>`). Adapters that only support "resume latest" or do not support persistent session continuity are **not** eligible to serve as the fixed executor in Deliberate Delegate.

4. **Result Path and Artifact Capture:**
   The execution result must be saved to a structured JSON file in the step directory (e.g. `result.vN.json`).

5. **Structured Result Contract (`delegate-relay.result.v1`):**
   The raw result JSON is produced by upstream adapters according to `delegate-relay.result.v1`. The Deliberate Delegate coordination layer consumes and maps these concepts:

   | Common concept | Raw delegate result field | Notes |
   |---|---|---|
   | `status` | `status` | Execution status string (e.g. `"completed"`, `"failed"`, `"timeout"`) |
   | `exit_code` | `exitCode` | Integer process exit code from provider CLI |
   | `session_ref` | Provider-specific | `sessionId` for Claude, `threadId` for Codex, `conversationId` for agy |
   | `touched_files` | `touchedFiles` | List of file paths modified during execution |

   The coordination layer may normalize these concepts in `state.json`, but must preserve the raw delegate result unchanged in `result.vN.json`. No universal raw session field exists across providers. These mappings were verified locally on 2026-09-01 against installed `claude-delegate`, `codex-delegate`, and `agy-delegate` skills at metadata version `0.5.0` plus actual result artifacts.

6. **No-Commit Declarations and Verification:**
   Upstream guarantees that the relay itself does not commit. Worker-level restrictions vary by provider and the run profile used. Each dispatch records `no_commit` as `transport_enforced`, `tool_guarded`, or `instruction_only`, based on the flags and tools actually used. Bypass or full-access execution is always `instruction_only` regardless of adapter defaults.

   *Verification Invariant:* The declared enforcement level informs risk assessment only. Planning Lead must always independently verify Git HEAD, index, branch, and full status before accepting any Step.

---

## Context Continuity

- No automated context-management or auto-compaction orchestration exists in the `0.1.0 MVP`.
- When a reliable provider-reported Claude context occupancy reaches 40%, the session owner performs provider-native in-place compaction in that exact same session before its next operation. The Planning Lead records the checkpoint and result.
- This rule applies whether Claude is serving as Planning Lead or Planner 2.
- Codex native auto-compaction remains provider-managed and does not require a Phase stop.
- Context maintenance in place does not stop the Phase. Stop execution only if the required exact session cannot be resumed or compacted reliably; replacing any session still requires direct human user approval.
- Never infer occupancy from unverified token estimates when the provider does not report a trustworthy metric.
- The future >90% provider usage/quota guard remains completely separate and deferred.

---

## Planner budgets and dispatch limits

- Planner 2 has no automatic dollar cap. Do not add `--max-budget-usd` unless
  the user explicitly requests a cap for that run.
- Generic budget metadata is optional. When the user or an approved executor
  dispatch configuration supplies a limit, record the actual effective limit
  and do not silently drop inherited or mandatory provider limits. This is
  instruction and dispatch policy, not helper enforcement.
- Keep timeout, `maxTurns`, provider limits, correction limits, and the single
  technical-retry safeguard. Do not claim that a timeout or `maxTurns` setting
  automatically saves tokens, and do not introduce a numeric Planner 2 call
  ceiling or an 85% quota pause without explicit approval.
- A nontransient exhausted quota, authentication, or budget failure is not a
  blind replay condition. Require evidence that the relevant condition is
  resolved and reconcile prior partial work before the one permitted technical
  retry; otherwise stop and escalate.

---

## Canonical Brief and Dispatch Envelope

- The immutable Step brief is provider-neutral and conforms to [the Brief and Result Contract](brief-contract.md).
- Provider-specific tuning belongs only to the dispatch envelope: adapter, exact-session resume syntax, model label, effort, timeout, budget, permission profile, no-commit enforcement, and non-secret CLI flags.
- An envelope must never change or append substantive objective, scope, acceptance criteria, verification procedures, safety policy, or result requirements. If a provider needs a substantive change, the planners create a new immutable brief version under the normal authorization and correction rules.
- Planning Lead records the actual effective envelope in `state.json` and preserves the raw adapter result. Never record credentials, tokens, auth data, or private configuration.

For a deliberate model comparison, every arm must receive the same canonical brief version from the same starting project snapshot, with the same authorized scope, permission profile, effort and budget limits where comparable, correction allowance, and evaluation rubric. Record unavoidable envelope differences separately. A substantive brief-content difference invalidates a model-quality comparison and must be disclosed.

---

## Core Consumption and Raw Preservation

- The Deliberate Delegate coordination layer consumes only the stable fields mapped from `delegate-relay.result.v1`.
- The complete raw result artifact from the adapter is preserved without modification in `result.vN.json` for auditability and debriefing.

---

## Supported Upstream Adapters

The following upstream adapters from `delegate-skills` are supported (without hardcoding specific model names):

| Adapter Skill | Provider CLI | Exact Resume Syntax | Raw Result Session Field | No-Commit Enforcement | Result Contract |
|---|---|---|---|---|---|
| `claude-delegate` | Anthropic Claude Code CLI | `--session <id>` | `sessionId` | Declared per dispatch | `delegate-relay.result.v1` |
| `codex-delegate` | OpenAI Codex CLI | `--session <id>` | `threadId` | Declared per dispatch | `delegate-relay.result.v1` |
| `agy-delegate` | Google Antigravity CLI | `--conversation <id>` | `conversationId` | Declared per dispatch | `delegate-relay.result.v1` |

---

## Operational Boundaries and Provider Runtime State

- **Transport Only:** The provider/model connection serves strictly as the execution transport. Delegated agents receive no permission for independent network access, MCP tool execution, or external service interactions unless explicitly authorized by the human user.
- **Provider Runtime External State (Option A2):** Provider CLIs may create or update external session-scoped runtime state only for the exact fixed session authorized for the project, inside the provider's documented session/scratch/cache area, with verifiable provenance and declared paths. This state may contain runtime/session transport data only; outside-root deletion is prohibited during unattended execution. For `agy-delegate`, the observed provider-owned pattern is `.gemini/antigravity-cli/brain/<conversation-id>/scratch/` (recorded generically without real identifiers or user paths). An adapter is eligible only when the Lead can apply these checks using available host evidence without claiming complete outside-root observability; otherwise the Phase stops.
- **Extensibility:** New provider adapters must be contributed upstream to `delegate-skills` or mapped only after verifying exact session resumption, structured result compliance, and no-commit enforcement. Adding or updating an adapter does not modify the Deliberate Delegate core lifecycle.
