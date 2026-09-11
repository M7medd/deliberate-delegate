# Deterministic Planner 2 bootstrap

Use `dd-bootstrap.mjs` before the Planning Lead inspects a project when a
controlled Planner 2 session bootstrap is authorized. It is a mechanical,
one-dispatch helper, not a workflow engine and not an authorization gate.

Run it from one host orchestration call that keeps the child wait inside that
call. The caller supplies the provider adapter and the complete argv envelope;
the helper does not choose a provider, model, effort, prompt, budget,
permissions, or session policy.

```powershell
node <skill-dir>\scripts\dd-bootstrap.mjs `
  --root <project> `
  --ledger docs\deliberate-delegate\experiment-usage.jsonl `
  --experiment-id dd-exp-001 `
  --lead-rollout C:\Users\name\.codex\sessions\YYYY\MM\DD\rollout.jsonl `
  --adapter <caller-selected-adapter> `
  --args-file docs\deliberate-delegate\raw\planner2\adapter-argv.json `
  --result docs\deliberate-delegate\raw\planner2\provider-result.json `
  --artifact-dir docs\deliberate-delegate\raw\planner2\controller `
  --planner2-source docs\deliberate-delegate\raw\planner2\relay `
  --confirmation docs\deliberate-delegate\raw\planner2\confirmation.json `
  --timeout-ms 1800000 `
  --suspension-available true `
  --context-evidence-file docs\deliberate-delegate\raw\planner2\context.json
```

Required project-relative paths are the ledger, adapter argv JSON file,
provider result JSON path, stable controller artifact directory, Planner 2
relay source, and confirmation output. The Planning Lead rollout is an exact
caller-selected source and may be outside the project because it is read-only.
`--timeout-ms` and `--suspension-available true|false` are mandatory; there is
no implicit timeout or suspension decision.

The argv file must contain a JSON array of strings. It carries the caller's
minimal session-bootstrap envelope/brief. When Claude is Planner 2, the caller
must include and record `--autocompact 400k` according to the provider contract.
The optional context evidence file is reduced to bounded non-secret context
fields in the output. It is caller-declared evidence only; the bootstrap never
claims provider enforcement. Without host telemetry proving zero Lead model
turns, the controller/capsule reports `suspensionStatus: unknown`.

The Planner 2 relay path is an output location and may be absent before the
adapter runs. Its actual events/result source is resolved only after a PASS or
REUSED terminal controller result. The Lead baseline retains only bounded
per-file prefix hashes and byte counts, so an append-only live rollout can be
reconciled without claiming that its current bytes equal the original baseline.

On a fresh run the helper initializes the append-only ledger, records the exact
Lead rollout as a zero-delta baseline, dispatches the adapter once through
`ProcessJobController`, validates a completed raw result with exactly one
normalized provider session field, and preserves the `role: planner` capsule
with `NEEDS_EVIDENCE`. It then captures Planner 2 relay usage and a separate
Lead confirmation-boundary usage record, and writes a compact confirmation
record that stops for direct human approval.

The controller directory is an explicit stable identity. A matching terminal
capsule is reconciled and reused on restart; the provider is not launched
again. Raw result, logs, job record, and capsule remain available when a later
usage or confirmation step fails. Malformed, missing, nonterminal, ambiguous,
conflicting, or unsafe evidence fails closed. Suspension unavailable writes a
controller stop record and dispatches zero providers.

The confirmation explicitly says that its Lead boundary was captured before the
command returned. It may not include the assistant's later user-facing
confirmation message and must not be treated as a complete post-human-seeing
turn. The command makes no Git changes, retries, role changes, Phase
transitions, authorization decisions, or cleanup decisions, and it makes no
token, cost, quota, or savings claim.
