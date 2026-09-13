# dd-runtime

`dd-runtime.mjs` is a dependency-free Node 18+ deterministic coordinator below
the Planning Lead. It stores project configuration, scoped verbatim human
questions and answers, atomic terminal transitions, scoped session bindings,
dispatch requests, events, result acknowledgements, and a regenerated status
projection. It does not interpret answers, choose a verdict or risk tier,
authorize a Phase, replace a role, or advance a workflow.

Run from the repository root:

```powershell
node skills/deliberate-delegate/scripts/dd-runtime.mjs --help
```

The supported commands are:

- `questionnaire` emits the exact asked categories and computed confirmation
  values. The records-root override is conditional when the default is rejected.
- `config create` and `config confirm` create immutable `dd.project-config.v1`
  and separate confirmation records. Confirmed versions form one linear chain;
  stale, forked, dangling, backward, and cyclic links stop.
- `question open`, `question answer`, `question withdraw`, `question list`, and
  `question inspect` manage `dd.question.v1`, `dd.answer.v1`, and
  `dd.question-withdrawal.v1`. Human text is read from files and complete records
  above 1 MiB stop before a partial write. Answer and withdrawal use one
  exclusive `terminal.json`; questions may be project-, Phase-, or exact
  Work-Package-scoped.
- `binding inspect` and `binding confirm` manage exact-session
  `dd.session-binding.v1` records after an explicit confirmer validates the
  single observed provider session ID. Binding paths include role and a SHA-256
  of the readable derived scope. `bind_existing` and authorized replacement
  evidence are explicit routes; no replacement is automatic.
- `dispatch` accepts a project-relative immutable brief, adapter envelope, and
  adapter-argv JSON file, then uses the existing `ProcessJobController` path for
  either public `planner-2` or `executor`. `planner-2` is mapped to capsule role
  `planner`. A first usable session result stops at
  `AWAITING_SESSION_BINDING`; later calls require the exact bound session. The
  confirmed role profile controls adapter/provider/model/effort/permission and
  Executor `noCommit`; conflicting caller duplicates stop. The envelope also
  carries bounded `dd.invocation-contract.v1` declarations checked against the
  actual argv before launch. `verified_requested` proves requested argv only,
  `not_applicable` is accepted only for a mapped non-transported capability,
  and `unverified` normally stops. The exact mapped Claude Executor
  `workspace-write` profile uses the existing `unverified` outcome with
  `adapter-parser/default_absence:acceptEdits`; its verified capsule evidence is
  labelled `adapter_default`/`default_absence` and checks bounded absence of
  permission/autonomy selectors. Explicit-only capsules use
  `requested_argv_only`; capsules containing this default evidence use
  `requested_argv_and_adapter_default`. Neither label proves provider
  application, OS sandboxing, filesystem containment, or no-commit enforcement.
- `result acknowledge` records that the Planning Lead handled a valid terminal
  capsule; it is not approval, a verdict, correction authority, or merge
  authority.
- `status` accepts scope and an optional deterministic `jobKey`, derives a
  bounded next-stop projection, and never scans historical jobs to guess a
  current result. It does not write Phase or Step state.

All input paths are project-relative and checked for traversal and reparse-point
escape. Records are create-once: identical canonical bytes are reused and
contradictory bytes stop. `dd.adapter-envelope.v1` remains per-dispatch and
`dd.dispatch-identity.v2` remains deterministic. Confirmed `providerFamily` is
closed and the deterministic runtime mappings are the mapped adapters
`claude-delegate` and `codex-delegate`, with role-specific coverage: Claude
Planner 2 uses explicit `--read-only` plus exactly one separated `--autocompact 400k`;
Claude Executor's configured `workspace-write` profile uses the measured normal
`acceptEdits` adapter default; Codex Planner 2 uses explicit `--read-only`; and
Codex Executor uses `--sandbox workspace-write`. Other adapters require an
independent measured capability mapping and unknown/unmapped adapters stop before
launch. For `claude-delegate`, the supported autocompact form is separated
`--autocompact 400k` in the relay option list; equals form and the `--` token are
not supported by the measured parser. Claude Executor default evidence rejects
all mapped permission/autonomy alternatives and any terminator before launch.
  Caller context JSON cannot verify these settings, and the evidence proves
  requested argv/parser or bounded adapter-default behavior only, not
  provider-side application, OS sandboxing, filesystem containment, or
  no-commit enforcement. Native Windows
Claude execution has no host OS sandbox attestation. Runtime stop records
use content-addressed paths; `envelope_rejected` is reserved for envelope
rejection and other mechanical stops use `stop_recorded`. `noCommit` classes are
declared capability/evidence classes, not OS attestation. Runtime attempts are
`initial`, `correction`, or `technical_replay`; non-initial attempts require
immutable authorization, physical attempts are consecutive, and correction
ordinals are independent. The one technical replay is per Work Package/job and
never resets for a later correction. Binding and pending records resolve only
through exact path/digest references; historical pending records remain audit
evidence. A binding is usable only after its complete connected role/scope chain
validates. The Planning Lead owns semantic no-progress judgment; runtime
enforces only immutable authorization, sequencing, and ceilings. The runtime records
evidence only and makes no token, quota, cost, or subscription-savings claim.
