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

Deliberate Delegate coordinates multi-agent planning and relies on upstream `*-delegate` skills for execution dispatch. To be eligible for a Work Package-scoped Executor role, a provider adapter must satisfy the following contract:

1. **Install and Authentication Verification:**
   The adapter or skill must support verifying that the underlying provider CLI tool is installed and authenticated prior to dispatch.

2. **Dispatch Command:**
   Execution is triggered by invoking the respective upstream delegate command owned by the installed skill.

3. **Exact Session Resumption:**
   The adapter must support resuming an exact existing session by identifier (e.g. `--session <id>` or `--conversation <id>`). Adapters that only support "resume latest" or do not support exact continuity for the authorized Work Package are **not** eligible to serve as its Executor.

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
   Upstream guarantees that the relay itself does not commit. Worker-level restrictions vary by provider and the run profile used. Each dispatch records `noCommit` as `adapter_policy_declared`, `host_tool_guarded`, or `instruction_only`. These are declared capability/evidence classes, not OS attestation; the runtime never records `transport_enforced`. Bypass or full-access execution is always `instruction_only` regardless of adapter defaults.

   *Verification Invariant:* The declared class informs risk assessment only. Planning Lead must always independently verify Git HEAD, index, branch, and full status before accepting any Step.

7. **Adapter Working-Directory and Invocation Envelope:**
   Every controlled `job` dispatch supplies a project-relative
   `dd.adapter-envelope.v1` with an effective working directory. With
   `cwdMode: inherits_process`, `adapterContract` is `null` and the adapter is
   declared to use the controller-pinned process cwd. With
   `cwdMode: adapter_contract`, bounded metadata names the adapter plus its cwd
   argument and value, and the value must match the argv supplied to the
   controller. Duplicate, contradictory, missing, out-of-root, or reparse-
   crossing declarations stop before provider launch. This is string-level
   declaration/contract evidence only: it cannot detect cwd obtained from
   environment, configuration, provider internals, or an unmodelled argument,
   and it is not OS attestation. The normalized envelope digest binds
   `dd.dispatch-identity.v2`; a CLI source-file digest is separate evidence and
   is not part of identity.

   The same per-dispatch envelope carries bounded, versioned
   `dd.invocation-contract.v1` declarations for the confirmed model, effort,
   permission, and any mandatory provider option. The runtime compares each
  declaration to the actual argv before launch. `verified_requested` proves
  the requested flag/value or presence form only; `not_applicable` is valid
  only for a mapped non-transported capability. Normally `unverified` stops,
  except for the exact mapped `claude-delegate + claude + executor +
  workspace-write` profile: it uses the existing `unverified` schema outcome
  with the exact `adapter-parser/default_absence:acceptEdits` reason, while the
  runtime records separate `adapter_default`/`default_absence` evidence. This
   The capsule labels explicit-only evidence `requested_argv_only` and uses
   `requested_argv_and_adapter_default` when this adapter-default evidence is
   present with explicit settings. These labels are not evidence that the
   provider applied or enforced the requested setting.

---

## Context Continuity

- Context management is recorded as non-authoritative evidence with one capability classification: `adapter_flag`, `provider_native_auto`, `provider_native_manual`, or `unsupported`. The record includes the threshold policy, target window, target compaction setting, observed occupancy when available, compact method/result, and whether an adapter flag was available. Unavailable metrics remain `unknown`.
- When Claude is Planner 2, automatic compaction is a preflight invariant, not a recommendation. Every substantive launch or exact-session resume must include exactly one mechanically inspected `--autocompact 400k` declaration in the actual dispatch argv. For `claude-delegate`, only the separated option-list form is supported; equals form and an option terminator are not supported by the measured relay parser. Caller context JSON, adapter-name spelling, an earlier launch, or a session ID does not verify the setting; provider-side application remains unproven.
- The 400k setting is the chosen automatic-compaction boundary for a 1,000,000-token Claude window. The earlier 40% observation motivated the value, but the Lead does not manually compact on a 40% schedule.
- In the tested environment, the bounded observation is: Windows, Claude Code `2.1.267`, observed `2026-09-10`; an in-place provider-native compact reported `56.4k/400k (14%)` afterward. This is one observation, not a benchmark or guarantee.
- The mapped `claude-delegate` capability is intentionally narrow: the runtime accepts one separated `--autocompact 400k` declaration in the relay option list and records requested-argv evidence. The measured parser rejects equals form and the `--` token itself. This proves the requested launch argument and evidence record only; it does not prove provider-side application or enforcement.
- Metadata version `0.5.0` alone is not sufficient proof: locally patched or fork-derived builds may retain that metadata version. Each environment must verify current relay help and the actual dispatch/result evidence; this snapshot does not imply the capability is present in every upstream installation.
- If the active adapter cannot pass and record the required setting, classify it as `unsupported` and stop before a substantive Claude Planner 2 call. This repository does not vendor or modify upstream adapter files.
- Manual provider-native compaction is recovery only. It is permitted in the exact same session after automatic compaction actually fails or when a concrete context problem appears. Record the trigger, method, and result. Do not use manual compaction merely because a new review, Step, or Work Package is starting, and do not use it as a routine substitute for an adapter that cannot enable the required automatic setting.
- The automatic preflight in this version is mandatory specifically when Claude is Planner 2. Other Claude roles may adopt the same setting, but are not covered by this role-specific invariant unless the Phase policy says so.
- Codex native auto-compaction remains provider-managed and does not require a Phase stop.
- Context maintenance in place does not stop the Phase. Stop execution only if
  the required exact role session cannot be resumed or compacted reliably;
  replacing any role holder still requires direct human user approval. A new
  Work Package may use a new Executor session with the same approved role holder
  without treating it as replacement.
- Never infer occupancy from unverified token estimates when the provider does not report a trustworthy metric.
- Context occupancy/compaction is separate from five-hour subscription usage or quota. The future >90% provider usage/quota guard remains completely separate and deferred.

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
- Provider-specific tuning belongs only to the dispatch envelope: adapter, exact-session resume syntax, model label, effort, timeout, budget, permission profile, no-commit declaration, and non-secret CLI flags.
- An envelope must never change or append substantive objective, scope, acceptance criteria, verification procedures, safety policy, or result requirements. If a provider needs a substantive change, the planners create a new immutable brief version under the normal authorization and correction rules.
- Planning Lead records the actual effective envelope in `state.json` and preserves the raw adapter result. Never record credentials, tokens, auth data, or private configuration.

The deterministic runtime records adapter identifiers, a closed `providerFamily`
(`claude`, `codex`, `gemini`, or `other`), and capability metadata in the
confirmed project configuration, but the actual executable and argv remain
inside the validated per-dispatch `dd.adapter-envelope.v1` request. The runtime
uses the confirmed role profile as the sole source of adapter, provider family,
model, effort, permission, and Executor `noCommit` values; differing caller
duplicates stop rather than override it. The runtime does not treat
configuration as authorization. A public `planner-2` dispatch is
passed to the capsule layer as role `planner`; a first result with one usable
session identifier returns `AWAITING_SESSION_BINDING` until a separate immutable
scope-keyed binding record is explicitly confirmed. A configured Claude Planner
2 role still requires per-launch argv inspection proving exactly one requested
 `--autocompact 400k` declaration; caller context JSON and adapter-name spelling
 do not satisfy that preflight, and the evidence proves the requested argument
 only, not provider-side application or enforcement.

### Deterministic runtime mapping

The general adapter table below describes upstream contract references. The
deterministic runtime has a narrower, measured capability registry:

1. `claude-delegate` and `codex-delegate` are mapped and regression-tested by
   role. Claude Planner 2 uses separated `--model`, `--effort`, `--read-only`,
   and exactly one separated `--autocompact 400k`. Claude Executor's configured
   `workspace-write` profile uses the measured normal `acceptEdits` default and
   requires bounded absence of `--read-only`,
   `--dangerously-skip-permissions`, `--permission-mode`, `--sandbox`, `--lane`,
   and `--permission-profile`. Codex Planner 2 uses explicit `--read-only`,
   Codex Executor uses explicit `--sandbox workspace-write`, and exact
   continuation uses `--session <id>`.
2. Any other adapter is usable only after its own parser and provider-family
   capability mapping is measured and added to the runtime.
3. An unknown or unmapped adapter, alias, or inconsistent adapter/provider-family
   pair stops before provider launch with capability-unverified evidence. The
   runtime does not accept `anthropic-relay` as a Claude alias merely because
   its name is convenient.

Explicit permission evidence is limited to requested argv/parser behavior.
Claude Executor's default evidence is an adapter-parser/default claim only:
native
Windows Claude execution has no host OS sandbox attestation, and the runtime
never claims provider application, OS isolation, filesystem containment,
sandbox enforcement, no-commit enforcement, or universal adapter support. The
runtime rejects contradictory permission selectors, broader/unmapped sandbox
values, and `--lane` when it could replace the selected default. The one
technical replay is per Work Package/job and never resets for a later
correction; physical attempt sequencing and correction ordinals remain runtime
mechanics, while semantic no-progress remains Planning-Lead-owned.

For a deliberate model comparison, every arm must receive the same canonical brief version from the same starting project snapshot, with the same authorized scope, permission profile, effort and budget limits where comparable, correction allowance, and evaluation rubric. Record unavoidable envelope differences separately. A substantive brief-content difference invalidates a model-quality comparison and must be disclosed.

---

## Core Consumption and Raw Preservation

- The Deliberate Delegate coordination layer consumes only the stable fields mapped from `delegate-relay.result.v1`.
- The complete raw result artifact from the adapter is preserved without modification in `result.vN.json` for auditability and debriefing.

---

## General upstream adapter references

The following upstream adapters from `delegate-skills` are documented contract
references (without hardcoding specific model names). Their presence here does
not make them deterministic runtime mappings:

| Adapter Skill | Provider CLI | Exact Resume Syntax | Raw Result Session Field | No-Commit Enforcement | Result Contract |
|---|---|---|---|---|---|
| `claude-delegate` | Anthropic Claude Code CLI | `--session <id>` | `sessionId` | Declared per dispatch | `delegate-relay.result.v1` |
| `codex-delegate` | OpenAI Codex CLI | `--session <id>` | `threadId` | Declared per dispatch | `delegate-relay.result.v1` |
| `agy-delegate` | Google Antigravity CLI | `--conversation <id>` | `conversationId` | Declared per dispatch | `delegate-relay.result.v1` |

---

## Operational Boundaries and Provider Runtime State

- **Transport Only:** The provider/model connection serves strictly as the execution transport. Delegated agents receive no permission for independent network access, MCP tool execution, or external service interactions unless explicitly authorized by the human user.
- **Provider Runtime External State (Option A2):** Provider CLIs may create or update external session-scoped runtime state only for the exact authorized role session for the Work Package, inside the provider's documented session/scratch/cache area, with verifiable provenance and declared paths. This state may contain runtime/session transport data only; outside-root deletion is prohibited during unattended execution. For `agy-delegate`, the observed provider-owned pattern is `.gemini/antigravity-cli/brain/<conversation-id>/scratch/` (recorded generically without real identifiers or user paths). An adapter is eligible only when the Lead can apply these checks using available host evidence without claiming complete outside-root observability; otherwise the Phase stops.
- **Extensibility:** New provider adapters must be contributed upstream to `delegate-skills` or mapped only after verifying exact session resumption, structured result compliance, and no-commit enforcement. Adding or updating an adapter does not modify the Deliberate Delegate core lifecycle.
