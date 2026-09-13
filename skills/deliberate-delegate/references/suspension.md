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

The `dd-runtime.mjs` coordinator uses this same controller path for both public
`planner-2` and `executor` roles. It records configuration, applicable scoped
question, binding/replacement, envelope, and content-addressed stop records
around the dispatch; it does not add polling, an LLM manager, automatic
verdicts, or a second workflow state machine. Its deterministic attempt path is
`runtime/jobs/<job-key>/attempt-<NN>/` and a returned first-session result stops
at `AWAITING_SESSION_BINDING` until a separate scoped confirmation record exists.
Result acknowledgement is an immutable handled-result boundary, not approval.

If the host reports that suspend-and-await is unavailable, the controller stores
`suspensionStatus: unavailable`, writes a stop record, dispatches zero workers,
and returns control to the user. There is no silent fallback to model polling.
When host capability is not known, the default is `unknown`. The `enforced`
schema value remains readable only for legacy structural validation; current
controller and capsule-emission APIs reject it, even with:

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
  adapterEnvelope: { schemaVersion: "dd.adapter-envelope.v1", effectiveWorkingDirectory: ".", cwdMode: "inherits_process", adapterContract: null },
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
`args`, parsed `adapterEnvelope`, project-relative raw `result`, and fresh
project-relative `artifactDir`; optional `role`, `expectedSession`,
`dispatchId`, `idempotencyKey`, `suspensionAvailable`, `hostTelemetry`,
`timeoutMs`, `changedPaths`, and `gateCoverage`. The CLI additionally accepts
`--adapter-envelope <project-relative-json>` and records that source file's
digest separately. When omitted, `idempotencyKey` is derived deterministically
from the v2 dispatch identity. Reuse the same artifact directory only to
reconcile the same identity; changed arguments, paths, or envelope declarations
fail closed. An invalid fresh envelope writes a durable stop with zero dispatches
before any provider launch.

The result is one object with `status` (`PASS`, `FAIL`, `REUSED`, `UNKNOWN`,
`UNAVAILABLE`, or `STOPPED_INVALID_ENVELOPE`), `dispatchCount`, `dispatchId`, `idempotencyKey`, optional
`capsule`/`capsulePath`, `sessionVerification`, `suspensionStatus`, and
`failureReasons`. `UNAVAILABLE` records a stop and dispatches zero workers;
`UNKNOWN` requires reconciliation and is never an implicit retry. A successful
v0.4 run writes the job record, raw logs/result, and verified result capsule.

## Codex single-call wait path

The Planning Lead must not launch a long delegate with a raw shell call that
returns a process/session handle to the model. That return samples the Lead
again and turns later status checks into model-driven polling.

On a Codex host that exposes an outer orchestration call plus nested command and
session-wait tools, keep the entire dispatch and wait loop inside the outer
call. Invoke the controller-backed CLI, not the legacy `run` command:

```js
// One outer orchestration-tool call. Values come from the frozen brief.
let current = await tools.exec_command({
  cmd: approvedJobCommand, // node <dd-efficiency.mjs> job ...
  workdir: approvedProjectRoot,
  yield_time_ms: 30000,
  max_output_tokens: 2000
});
while (current.session_id !== undefined) {
  current = await tools.write_stdin({
    session_id: current.session_id,
    chars: "",
    yield_time_ms: 60000,
    max_output_tokens: 2000
  });
}
text(current.output);
```

Set the outer call's own yield deadline beyond the authorized job timeout when
the host permits it. A periodic host notification is allowed only when it does
not sample the Lead. Do not call `write_stdin` from a later Lead turn, do not
send narrative waiting updates, and do not start a second adapter attempt.

The `job` command requires an explicit capability decision:

```powershell
node "$helper" job --root . --adapter "$adapterExecutable" --adapter-envelope docs/deliberate-delegate/raw/attempt-01/adapter-envelope.json --args-json "$approvedAdapterArgsJson" --result docs/deliberate-delegate/raw/attempt-01/result.json --expected-session "$executorSession" --artifact-dir docs/deliberate-delegate/raw/attempt-01/adapter --suspension-available true
```

Use `--suspension-available false` when the outer host cannot keep the wait in
one orchestration call; the controller then writes a stop record and dispatches
zero workers. The single-call structure prevents intermediate Lead turns, but
it still records `suspensionStatus: unknown` unless independent host telemetry
reports `leadModelTurnsBetweenDispatchAndTerminal: 0`.

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
| Planner | `APPROVE`, `BLOCK`, `NEEDS_EVIDENCE`, `TRANSPORT_FAILED` |
| Mechanical runner | `PASS`, `FAIL`, `UNKNOWN` |

SHA-256 is an integrity check only when the expected digest is trusted. It is
not a signature, identity proof, or provenance proof. Adapter cwd matching is
string-level declaration/contract evidence, not OS attestation. A missing,
malformed, or mismatched digest invalidates a terminal capsule. A nonterminal,
stale, malformed, or session-mismatched result is rejected; it is not approval.

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
or raise that policy. The Planning Lead applies the structured correction policy
to decide whether the same blocking defects remain without new relevant evidence
or a meaningful delta; that decision is recorded as `STOPPED_NO_PROGRESS`.
Reaching the configured limit is `STOPPED_CORRECTION_LIMIT`. Both outcomes stop
the Phase for user intervention; the deterministic runtime does not infer either
semantic conclusion from arbitrary text.

## Controlled pilot boundary

The release's one-dispatch/one-wait path is not an A/B pilot. Do not claim
token, cost, quota, or universal suspension savings from unit tests, host-call
counts, visible bytes, or an awaited Promise. A valid pilot holds brief,
provider/model/effort, risk tier, permission profile, starting snapshot, and
gate rubric constant and changes only suspension off versus on. The primary
metric is host telemetry showing exactly zero Lead sampled model turns between
dispatch and terminal result in the treatment arm. Planner 2 usage is measured
separately.
