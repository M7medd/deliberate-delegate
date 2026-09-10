# DD usage recorder

`dd-usage.mjs` is a dependency-free Node 18+ experiment helper. It records
provider-reported usage from the beginning of a run without asking an agent to
reconstruct consumption afterward.

The recorder writes one append-only JSONL ledger inside the selected project
root. It reads, but never copies, prompt or transcript artifacts. Only numeric
usage, bounded role/session identifiers, status, redacted source locators, and
SHA-256 source digests enter the ledger. Paths inside the project are stored
relative to its root; outside paths are represented by a hashed locator.
Missing measurements remain `unknown`.

## Minimal experiment flow

Initialize before the Planning Lead inspects the project:

```powershell
node <skill-dir>\scripts\dd-usage.mjs init `
  --root . `
  --ledger docs\deliberate-delegate\experiment-usage.jsonl `
  --experiment-id dd-exp-001
```

Record the Lead's exact Codex rollout as a zero-delta baseline:

```powershell
node <skill-dir>\scripts\dd-usage.mjs capture `
  --root . `
  --ledger docs\deliberate-delegate\experiment-usage.jsonl `
  --role planning-lead `
  --source C:\Users\name\.codex\sessions\YYYY\MM\DD\rollout-....jsonl `
  --label start `
  --baseline
```

After each Work Package, capture the same Lead rollout again and ingest each
Planner 2 or Executor relay run directory:

```powershell
node <skill-dir>\scripts\dd-usage.mjs capture --root . --ledger docs\deliberate-delegate\experiment-usage.jsonl --role planning-lead --source <lead-rollout.jsonl> --label wp-01
node <skill-dir>\scripts\dd-usage.mjs capture --root . --ledger docs\deliberate-delegate\experiment-usage.jsonl --role planner-2 --source <claude-run-dir> --label wp-01-review
node <skill-dir>\scripts\dd-usage.mjs capture --root . --ledger docs\deliberate-delegate\experiment-usage.jsonl --role executor --source <executor-run-dir> --label wp-01
```

Print the compact cumulative view:

```powershell
node <skill-dir>\scripts\dd-usage.mjs report --root . --ledger docs\deliberate-delegate\experiment-usage.jsonl
```

Repeated capture of byte-identical source artifacts is idempotent. A growing
Codex rollout produces cumulative snapshots and the ledger records the delta
from its previous capture. The first Lead capture must use `--baseline` so work
that predates the experiment is not counted.

`complete_for_captured` in a report means every source that was actually
captured supplied that metric. It does not prove that every run was captured.

## Measurement boundaries

- Claude `modelUsage` is preferred over the shorter terminal `usage` object and
  includes failed calls when their run artifacts are captured.
- Claude `rate_limit_event` and Codex `token_count.rate_limits` are recorded when
  present. Their absence is `unknown`; no token-to-subscription conversion is
  attempted.
- Provider cost is provider-reported/list-price metadata. It is not asserted to
  be a subscription charge or invoice.
- The Codex local rollout format is a measured local interface, not a stable
  public contract. If a provider changes its event shape, retain the raw source
  and report incomplete coverage instead of estimating.
- Do not point the recorder at unrelated sessions. Pin the exact Planning Lead,
  Planner 2, and Executor sources at experiment start.
