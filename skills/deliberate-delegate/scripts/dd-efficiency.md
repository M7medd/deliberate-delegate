# dd-efficiency

Dependency-free Node 18+ Lead-side helper; Git required for snapshot/gate.
See [usage and safety limits](../references/efficiency.md).
Run `node <skill-path>/scripts/dd-efficiency.mjs --help` for syntax.
Output stays at caller-selected fresh artifact paths inside the project root.
No installation, cleanup, authorization, planner decision, or provider transport
is implemented. For one-dispatch/one-wait provider jobs, use the `job` command,
which delegates to `lib/job-controller.mjs` and `lib/result-capsule.mjs`. The
CLI remains a mechanical runner, not a workflow engine.
