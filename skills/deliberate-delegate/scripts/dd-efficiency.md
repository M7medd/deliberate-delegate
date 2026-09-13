# dd-efficiency

Dependency-free Node 18+ Lead-side helper; Git required for snapshot/gate.
See [usage and safety limits](../references/efficiency.md).
Run `node <skill-path>/scripts/dd-efficiency.mjs --help` for syntax.
Output stays at caller-selected fresh artifact paths inside the project root.
No installation, cleanup, authorization, planner decision, or provider transport
is implemented. For one-dispatch/one-wait provider jobs, use the `job` command,
which delegates to `lib/job-controller.mjs` and `lib/result-capsule.mjs`. The
CLI remains a mechanical runner, not a workflow engine.

For adapter arguments, prefer a project-relative JSON array through
`--args-file` on shells where inline JSON quoting is fragile. Repeated `--arg`
preserves argument order and avoids JSON quoting; `--args-json` remains
available for hosts that pass argv directly. Do not combine `--args-file` with
either alternative. The `job` capsule roles are `executor`, `planner`, and
`mechanical`; workflow role `planner-2` maps explicitly to capsule role
`planner` at the caller boundary and is rejected if passed directly.

The companion `dd-runtime.mjs` CLI adds deterministic project configuration,
scoped verbatim human-question records with one atomic terminal, explicit
first-session binding/replacement evidence, mechanical Claude argv inspection,
result acknowledgement, and a derived next-stop projection below the Planning
Lead. It uses the same controller-backed wait path for Planner 2 and Executor
but never interprets answers, authorizes a Phase, chooses a verdict, or claims
consumption savings. The confirmed role profile constrains dispatch; each
adapter envelope carries a bounded invocation contract checked against actual
argv. Attempts are recorded as `initial`, `correction`, or `technical_replay`;
non-initial policy is enforced with immutable authorization evidence, while
binding and attempt records use numeric ordering and connected-chain validation.
