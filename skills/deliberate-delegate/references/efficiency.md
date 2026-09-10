# Lead-side efficiency helper

Read this reference before the first applicable check or dispatch in a DD run.
Choose the optional helper when it is compatible; otherwise record the concrete
incompatibility and equivalent check coverage in Lead evidence. Requires Node
18+ and Git; no packages, daemon, database or provider transport. It reduces
host/model interactions, not mandatory review. It never approves, retries,
commits, changes state, replaces role holders or starts another Phase. The exact
safety capsule and all human/planner gates remain mandatory.

## Snapshot and gate

Freeze the approved brief, validator configuration and governance inputs first.
Run from the explicit repository root; subdirectories are rejected. `$helper`
is the installed skill's `scripts/dd-efficiency.mjs` path. Replace example scopes
and paths with the approved project's actual ones.

```powershell
node "$helper" snapshot --root . --allow src --allow tests --out docs/deliberate-delegate/raw/attempt-01/baseline.json
node "$helper" gate --root . --baseline docs/deliberate-delegate/raw/attempt-01/baseline.json --allow src --allow tests --validators validators.json --exclude docs/deliberate-delegate/raw/attempt-01/adapter --artifact-dir docs/deliberate-delegate/raw/attempt-01/gate
```

Use the same `--allow` scopes for both commands so pre-existing ignored files in
those scopes have a baseline. Tracked and non-ignored untracked files are checked
across the repo, including existing dirt. Unchanged dirt is reported; changed
out-of-scope paths and unexpected HEAD/branch/staged entries fail. Index identity
hashes staged entries, not Git's refreshable stat cache. Ignored files outside
selected scopes and outside-root effects are not covered. An initial commit is
required. Unsupported/unreadable inventory fails closed.

`validators.json` is Lead-reviewed executable authority, not executor input or a
sandbox. Supply executable + argument arrays, for example:

```json
[{"name":"unit tests","executable":"node","args":["--test","tests/unit.test.mjs"]}]
```

Optional `cwd` is project-relative. Commands use `shell:false`; shell built-ins
and `.cmd` wrappers need an explicitly reviewed executable invocation. Content
and Git identity are checked **after** validators to catch their writes. Zero
validators means no tests ran, not that tests passed; compare checks to the brief.

The baseline and fresh output are recorded exclusions. Repeatable `--exclude`
is only for narrowly declared Lead-owned run artifacts, never deliverables or a
broad record tree. Read the summary's `exclusions` field before accepting coverage.
Exclusions/output cannot overlap the allowlist. Existing output directories,
traversal and owned-path symlink/junction crossings are rejected.
This is not an adversarial filesystem sandbox or an outside-write detector.

## Legacy CLI `run` versus the v0.4 controller path

Use the installed adapter's actual executable, argv, immutable brief, permission
flags and exact resume ID. `$approvedAdapterArgsJson` is a JSON array prepared
from that adapter's instructions; its result path must match `--result` below.

```powershell
node "$helper" run --root . --adapter "$adapterExecutable" --args-json "$approvedAdapterArgsJson" --result docs/deliberate-delegate/raw/attempt-01/adapter/result.json --expected-session "$executorSession" --artifact-dir docs/deliberate-delegate/raw/attempt-01/adapter/wait
```

The CLI `run` command is the legacy wait/summary helper. It dispatches once,
awaits the owned child, streams full logs and returns one legacy summary. It does
not create the v0.4 job record or result capsule, enforce deterministic
idempotency/reconciliation, or prove `suspensionStatus: enforced`. Use the
exported `ProcessJobController` path documented in [Awaiting and Result
Capsules](suspension.md) when v0.4 job/capsule evidence is required.

The in-process controller persists a job identity before dispatch and returns
the same Promise to concurrent callers. It is not a model-progress polling loop.
Use the host's completion/wait facility without repeated model progress probes;
background notification is host-dependent. Success requires process exit 0 and
new JSON with `status: "completed"`, integer `exitCode: 0`. Expected session, when
supplied, must match an explicit `sessionId`, `threadId`, `conversationId`,
`sessionRef` or `session_ref` field. Missing/malformed/nonterminal/stale results,
failed exits and mismatches fail. A result observed before process exit is
recorded as such; process and result terminal conditions remain separate. The
full adapter contract still needs Lead review.

The normal path has no model-driven polling, repeated status prompts, transcript
rereads, or approval echoes. If the host cannot suspend the Lead, record
`suspensionStatus: unavailable` and stop. Do not silently fall back to model
polling. Without explicit host telemetry showing zero Lead sampled model turns,
the capsule records `suspensionStatus: unknown`, even when the child wait was
successful. Only host telemetry can justify `enforced`.

Without `--expected-session`, `sessionVerification` is `not_requested` and coverage
explicitly states continuity was not checked. Such a mechanical result cannot
satisfy the Work Package's exact-session gate. For actual workflow dispatches
supply the exact authorized ID. Unlike snapshot/gate, run/index accept any explicit
project directory (no Git is needed for waiting or navigation). All run/index tests
use isolated non-repository directories; use the repository root in the workflow.

The helper's CLI `run` wrapper is optional. Do not force it around a native
in-process delegation path; use `ProcessJobController` or an equivalent owned
awaitable and apply the same exact-session, raw-result, capsule, and verification
requirements. Record the equivalent coverage.

`--timeout-ms` defaults to 1800000; `0` disables it. Timeout requests child kill
only. After the owned process exits, log draining is bounded to five seconds;
expiry closes the streams, sets `logDrainTimedOut: true` and fails. Raw logs may
then be incomplete and descendants may still run. On Windows, report child-only
termination unless Job Object coverage is independently proven. Never retry while
prior work may still be running; the helper cannot authorize retries, role
replacement, or session changes.

## Evidence and records

Gate/run emit JSON and exit 0 for mechanical PASS, 1 for FAIL, 2 for invocation
errors. Default summary limit is 8192 UTF-8 bytes (`--max-summary-bytes`, minimum
512). Full `details.json`, status, patches, fingerprint changes and validator/
adapter logs remain on disk. Omitted items have counts and raw locators. Inspect
relevant details for failures, uncertainty and review requirements. PASS is not
acceptance. Full raw records remain available, not loaded wholesale by default.

```powershell
node "$helper" index --root . --records docs/deliberate-delegate/phases/phase-01 --out docs/deliberate-delegate/phases/phase-01/INDEX.generated.md
```

The index is generated/non-authoritative and links existing records. Only a file
starting with the exact generated marker may be regenerated. Plans, debates,
results and decisions remain immutable; `state.json` is the sole mutable workflow
state record. New runs may use `raw/attempt-NN/` with adapter/gate subdirectories.
Old records are not moved, deleted, migrated or deduplicated.

Load the active pointer, governing rules, accepted requirements and relevant
evidence. Compact summaries do not replace raw evidence. Initial dual review
examines the actual implementation diff and checks; correction review uses
parent decision/evidence references, defect IDs, correction diff, affected criteria
and regression outputs. Either planner can expand inspection within authorized
read scope without automatically receiving new write scope. Contradictions reopen
affected findings; both explicit approvals, full canonical briefs and verbatim
visible debate preservation remain required.

## Measurement claims

For each accepted equivalent result, record all failed attempts, calls, cache
creation and reads, outputs, and defects. Compare packaging choices separately
from helper use or a changed cap; do not attribute a packaging difference to the
helper. Cached input/list processing is not paid subscription usage; cached
token counts and list-price estimates do not establish billed cost or
subscription quota. If the cause of cache recreation is unknown, record that
cause as unknown. Host-call counts and visible bytes are not measured token,
cost, or quota savings; a live A/B is required for that claim.
