# Awaiting, result capsules, and v0.4 recovery

This reference describes the v0.4 release's awaitable execution path. It is
mechanical evidence support, not an authorization or planner-decision engine.

## One dispatch and one wait

`ProcessJobController` owns one child process. `dispatch()` returns the same
Promise to concurrent callers, persists a dispatch identity and idempotency key
before spawning, and awaits the owned process exit plus the terminal result
artifact. A filesystem event may observe a result written before process exit;
the controller still reports process and result conditions separately. It does
not poll status, send progress prompts, reread transcripts, generate approval
echoes, or run a model loop.

The controller is deliberately not a daemon, database, scheduler, provider
failover layer, or second Phase/Step state machine. Provider-specific transport
and exact-session syntax remain in the upstream adapter envelope.

If the host reports that suspend-and-await is unavailable, the controller stores
`suspensionStatus: unavailable`, writes a stop record, dispatches zero workers,
and returns control to the user. There is no silent fallback to model polling.
When host capability is not known, the default is `unknown`. `enforced` is valid
only with explicit host telemetry proving:

```json
{"leadModelTurnsBetweenDispatchAndTerminal": 0}
```

An awaited Promise or owned child-process wait is a mechanism, not proof that
the host sampled zero Lead turns.

## Runnable controller path

From the repository root, the exported controller can be invoked directly. The
example uses Node as a harmless adapter and writes a terminal provider result;
real dispatches replace only the adapter and arguments after the normal brief,
session, and authorization gates have passed:

```js
import { dispatchProcessJob } from "./skills/deliberate-delegate/scripts/lib/job-controller.mjs";

const outcome = await dispatchProcessJob({
  root: process.cwd(),
  adapter: process.execPath,
  args: ["-e", "const fs=require('node:fs');fs.writeFileSync('docs/deliberate-delegate/raw/attempt-01/result.v1.json',JSON.stringify({status:'completed',exitCode:0,sessionId:'executor-session-uuid'}));"],
  result: "docs/deliberate-delegate/raw/attempt-01/result.v1.json",
  artifactDir: "docs/deliberate-delegate/raw/attempt-01/adapter",
  role: "executor",
  expectedSession: "executor-session-uuid",
  suspensionAvailable: true,
  timeoutMs: 1800000
});

console.log(JSON.stringify({
  status: outcome.status,
  dispatchId: outcome.dispatchId,
  idempotencyKey: outcome.idempotencyKey,
  capsulePath: outcome.capsulePath,
  suspensionStatus: outcome.suspensionStatus
}, null, 2));
```

The controller options are: required `root`, executable `adapter`, string
`args`, project-relative raw `result`, and fresh project-relative `artifactDir`;
optional `role`, `expectedSession`, `dispatchId`, `idempotencyKey`,
`suspensionAvailable`, `hostTelemetry`, `timeoutMs`, `changedPaths`, and
`gateCoverage`. When omitted, `idempotencyKey` is derived deterministically
from the dispatch identity. Reuse the same artifact directory only to reconcile
the same identity; changed arguments or paths fail closed.

The result is one object with `status` (`PASS`, `FAIL`, `REUSED`, `UNKNOWN`, or
`UNAVAILABLE`), `dispatchCount`, `dispatchId`, `idempotencyKey`, optional
`capsule`/`capsulePath`, `sessionVerification`, `suspensionStatus`, and
`failureReasons`. `UNAVAILABLE` records a stop and dispatches zero workers;
`UNKNOWN` requires reconciliation and is never an implicit retry. A successful
v0.4 run writes the job record, raw logs/result, and verified result capsule.

## Result capsule contract

`result-capsule.mjs` emits `dd.result-capsule.v1`. A capsule is bounded and
points to full raw evidence; it does not embed a transcript. It carries:

- unique `dispatchId`, `idempotencyKey`, `createdAt`, and `completedAt`;
- `role` and `adapter`, with role-scoped `status`/`roleStatus`;
- process and provider-result terminal statuses, exit code, signal, timeout,
  log-drain and process-tree observations;
- requested and observed session IDs plus `sessionVerification`;
- `suspensionStatus` and its evidence basis;
- every raw artifact locator and its SHA-256 digest;
- bounded changed-path and gate-coverage summaries;
- truncation flags, omitted-item counts, and raw locators when items are
  omitted; and
- `providerUsage` only when the provider supplied it.

The status vocabulary is intentionally not universal:

| Role | Allowed status |
| --- | --- |
| Executor | `READY_FOR_VERIFICATION`, `FAILED` |
| Planner | `APPROVE`, `BLOCK`, `NEEDS_EVIDENCE` |
| Mechanical runner | `PASS`, `FAIL`, `UNKNOWN` |

SHA-256 is an integrity check only when the expected digest is trusted. It is
not a signature, identity proof, or provenance proof. A missing, malformed, or
mismatched digest invalidates a terminal capsule. A nonterminal, stale,
malformed, or session-mismatched result is rejected; it is not approval.

## Idempotency and restart recovery

The immutable job record is written before dispatch. The default idempotency key
is a SHA-256-derived value over the stable dispatch identity, including role,
adapter, arguments, result path, expected session, artifact paths, and timeout.
A duplicate request with a verified terminal capsule whose dispatch identity,
`dispatchId`, and idempotency key match the persisted job returns/reuses that
capsule and does not execute the worker again. A job record without a verified terminal capsule is `UNKNOWN`
until reconciled; the controller never assumes success and never retries while a
prior process may still write. A raw result that predates a new dispatch without
the matching job/capsule is stale and is not consumed.

One technical replay is permitted only after the prior process is proven
terminal and the failure condition is shown resolved. Corrections are separate
immutable brief versions and follow the Phase policy. There is no blind retry
loop, automatic failover, or role replacement.

On timeout, the owned child receives a termination request. Unless the platform
implementation proves stronger coverage, the report says `child-only`; on
Windows descendants may survive. A bounded five-second log drain may mark raw
logs incomplete. Partial workspace edits remain for inspection. No automatic
`git reset`, `git checkout`, deletion, or cleanup is permitted.

## Correction policy

The Phase record supplies `maxCorrections` from `0` through the absolute
v0.4 ceiling of `3`; the default remains `2`. The executor cannot replace
or raise that policy. A correction with the same blocking defects and no new
relevant evidence or meaningful delta is `STOPPED_NO_PROGRESS`. Reaching the
configured limit is `STOPPED_CORRECTION_LIMIT`. Both outcomes stop the Phase
for user intervention.

## Controlled pilot boundary

The release's one-dispatch/one-wait path is not an A/B pilot. Do not claim
token, cost, quota, or universal suspension savings from unit tests, host-call
counts, visible bytes, or an awaited Promise. A valid pilot holds brief,
provider/model/effort, risk tier, permission profile, starting snapshot, and
gate rubric constant and changes only suspension off versus on. The primary
metric is host telemetry showing exactly zero Lead sampled model turns between
dispatch and terminal result in the treatment arm. Planner 2 usage is measured
separately.
