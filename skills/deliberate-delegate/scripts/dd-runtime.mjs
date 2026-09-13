#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertRelativeInput, readOwnedFile, realDirectory } from "./lib/lifecycle-core.mjs";
import { RuntimeCoordinator, runtimeStatus } from "./lib/runtime-coordinator.mjs";

const HELP = `dd-runtime — deterministic coordination runtime (dd-runtime.v1)

Commands:
  questionnaire --root <project> [--records-root <relative-dir>]
  config create --root <project> --answers-file <relative-json> [--version <n>] [--supersedes <sha256>]
  config confirm --root <project> --version <n> --digest <sha256> --confirmed-by <actor>
  question open --root <project> --question-file <relative-json>
  question answer --root <project> --question-key <key> --answer-file <relative-file>
  question withdraw --root <project> --question-key <key> --reason-file <relative-file>
  question list --root <project>
  question inspect --root <project> --question-key <key>
  binding inspect --root <project> [--role planner-2|executor]
  binding confirm --root <project> --role <role> --scope <scope> --session-id <id> --source-result <relative-json> --confirmed-by <actor>
  dispatch --root <project> --role planner-2|executor --job-key <relative-key>
           --phase-key <key> --work-package-key <key>
           --brief <relative-file> --adapter <executable> --adapter-envelope <relative-json>
           --args-file <relative-json> [--create-session true] [--candidate-session-id <id>]
           [--candidate-session-file <relative-file>] [--attempt <n>]
           [--attempt-kind initial|correction|technical_replay]
           [--correction-ordinal <n>] [--attempt-authorization-file <relative-file>]
           [--attempt-authorization-digest <sha256>]
           [--adapter-identifier <id>] [--provider-family <family>]
           [--model-label <label>] [--effort <level>]
           [--permission-profile <profile>] [--no-commit <class>]
  result acknowledge --root <project> --capsule <relative-json>
           --acknowledgement-file <relative-file> [--acknowledged-by <actor>]
  status --root <project> [--phase-key <key> --work-package-key <key>] [--job-key <key>]

Schemas:
  dd.project-questionnaire.v1, dd.project-config.v1, dd.question.v1,
  dd.answer.v1, dd.question-withdrawal.v1, dd.session-binding.v1,
  dd.result-acknowledgement.v1,
  dd.adapter-envelope.v1, dd.invocation-contract.v1, dd.dispatch-identity.v2,
  dd.result-capsule.v1.

All project paths are relative to --root and are contained within it; symlink/reparse
crossings fail closed. Verbatim question/answer/brief content is accepted through
files, not inline strings. Dispatch requires phaseKey and workPackageKey, and
 confirmed providerFamily controls mapped adapter argv inspection. The
 deterministic runtime mappings are the mapped adapters claude-delegate and
 codex-delegate, with role-specific coverage: Claude Planner 2 uses
 explicit --read-only plus separated --autocompact 400k; Claude Executor's
 configured workspace-write profile uses the measured normal acceptEdits adapter
 default and bounded absence of permission/autonomy selectors; Codex Planner 2
 uses explicit --read-only; Codex Executor uses --sandbox workspace-write.
 Other adapters require their own measured capability mapping, and
 unknown/unmapped adapters stop before launch. Records and result capsules are
 evidence, not authority. Confirmed role profiles and bounded invocation
  contracts govern adapter identity and requested argv. Explicit selectors are
  recorded as requested-argv evidence; Claude Executor's default is recorded
  as adapter-parser/default_absence evidence, not verified_requested. Capsules
  use requested_argv_only for explicit-only evidence and
  requested_argv_and_adapter_default when both classes are present.
 Claude's native Windows execution has no host OS sandbox attestation. The
 claude-delegate adapter accepts separated --autocompact 400k only; its measured
 relay parser rejects equals form and the -- option terminator. Codex file-only
 permission maps read-only to --read-only and workspace-write to --sandbox
  workspace-write; contradictory or broader selectors stop. These evidence
  labels do not prove provider application, OS sandboxing, filesystem
  containment, or no-commit enforcement. The runtime never
approves work, interprets human answers, chooses a verdict or
risk tier, authorizes a Phase, replaces a session, or advances a workflow.
Exit behavior: 0 for HELP and valid non-failure output, including the successful
AWAITING_SESSION_BINDING dispatch result; 1 for STOPPED/FAIL/FAILED/UNKNOWN/
UNAVAILABLE results, failed dispatch status, or dispatch stop codes other than
AWAITING_SESSION_BINDING.
No command installs packages, uses the network, runs Git, or launches a provider
unless the dispatch preflight has passed.
`;

function parseArgs(argv) {
  const values = { _: [], arg: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      values._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      values._.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    const key = equals >= 0 ? raw.slice(0, equals) : raw;
    let value = equals >= 0 ? raw.slice(equals + 1) : argv[index + 1];
    if (equals < 0 && value !== undefined && !value.startsWith("--")) index += 1;
    else if (equals < 0) value = true;
    if (key === "arg") values.arg.push(value);
    else values[key] = value;
  }
  return values;
}

function bool(value, label) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

async function projectJson(root, relative, label) {
  const rel = assertRelativeInput(relative, label);
  const bytes = await readOwnedFile(root, rel, label);
  return JSON.parse(bytes.toString("utf8"));
}

async function projectText(root, relative, label) {
  const rel = assertRelativeInput(relative, label);
  return (await readOwnedFile(root, rel, label)).toString("utf8");
}

function rootOptions(values) {
  return { root: values.root ?? process.cwd(), recordsRoot: values["records-root"] ?? values.recordsRoot };
}

async function execute(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return { exitCode: 0, result: { status: "HELP" } };
  }
  const command = argv[0];
  const values = parseArgs(argv.slice(1));
  const root = await realDirectory(values.root ?? process.cwd(), "root");
  const coordinator = new RuntimeCoordinator(rootOptions({ ...values, root }));
  let result;
  if (command === "questionnaire") {
    result = await coordinator.questionnaire({
      derivedInput: values["derived-input-file"] ? await projectJson(root, values["derived-input-file"], "derived input") : {},
    });
  } else if (command === "config") {
    const action = values._[0];
    if (action === "create") {
      result = await coordinator.createConfiguration({
        ...(values.version === undefined ? {} : { version: integer(values.version, "version") }),
        answers: await projectJson(root, values["answers-file"], "answers file"),
        supersedes: values.supersedes ?? null,
      });
    } else if (action === "confirm") {
      result = await coordinator.confirmConfiguration({
        version: integer(values.version, "version"),
        digest: values.digest,
        confirmedBy: values["confirmed-by"] ?? values.confirmedBy,
      });
    } else {
      throw new Error("config requires create or confirm");
    }
  } else if (command === "question") {
    const action = values._[0];
    if (action === "open") {
      const input = await projectJson(root, values["question-file"], "question file");
      result = await coordinator.openQuestion(input);
    } else if (action === "answer") {
      result = await coordinator.answerQuestion({
        questionKey: values["question-key"] ?? values.questionKey,
        answer: await projectText(root, values["answer-file"], "answer file"),
      });
    } else if (action === "withdraw") {
      result = await coordinator.withdrawQuestion({
        questionKey: values["question-key"] ?? values.questionKey,
        reason: await projectText(root, values["reason-file"], "withdrawal reason file"),
      });
    } else if (action === "list") {
      result = await coordinator.listQuestions();
    } else if (action === "inspect") {
      result = await coordinator.inspectQuestion({ questionKey: values["question-key"] ?? values.questionKey });
    } else {
      throw new Error("question requires open, answer, withdraw, list, or inspect");
    }
  } else if (command === "binding") {
    const action = values._[0];
    if (action === "inspect") {
      result = await coordinator.inspectSessionBindings({ role: values.role });
    } else if (action === "confirm") {
      result = await coordinator.confirmSessionBinding({
        role: values.role,
        scope: values.scope,
        sessionId: values["session-id"] ?? values.sessionId,
        sourceResultPath: values["source-result"] ?? values.sourceResult,
        sourceResultDigest: values["source-result-digest"] ?? values.sourceResultDigest,
        confirmedBy: values["confirmed-by"] ?? values.confirmedBy,
        provider: values.provider,
        replaceSession: values["replace-session"] === undefined ? undefined : bool(values["replace-session"], "replace-session"),
        replacementVersion: values["replacement-version"] === undefined ? undefined : integer(values["replacement-version"], "replacement-version"),
        replacementAuthorizationPath: values["replacement-authorization-file"],
        replacementAuthorizationDigest: values["replacement-authorization-digest"],
      });
    } else {
      throw new Error("binding requires inspect or confirm");
    }
  } else if (command === "dispatch") {
    const args = values["args-file"]
      ? await projectJson(root, values["args-file"], "args file")
      : values["args-json"]
        ? JSON.parse(values["args-json"])
        : values.arg;
    const contextEvidence = values["context-evidence-file"] ? await projectJson(root, values["context-evidence-file"], "context evidence") : undefined;
    result = await coordinator.dispatch({
      role: values.role,
      jobKey: values["job-key"] ?? values.jobKey,
      phaseKey: values["phase-key"] ?? values.phaseKey,
      workPackageKey: values["work-package-key"] ?? values.workPackageKey,
      purpose: values.purpose,
      briefPath: values.brief ?? values["brief-file"],
      adapter: values.adapter,
      adapterIdentifier: values["adapter-identifier"] ?? values.adapterIdentifier,
      providerFamily: values["provider-family"] ?? values.providerFamily,
      modelLabel: values["model-label"] ?? values.modelLabel,
      effort: values.effort,
      permissionProfile: values["permission-profile"] ?? values.permissionProfile,
      noCommit: values["no-commit"] ?? values.noCommit,
      provider: values.provider,
      args,
      adapterEnvelopePath: values["adapter-envelope"] ?? values.adapterEnvelope,
      roleStatus: values["role-status"] ?? values.roleStatus,
      createSession: values["create-session"] === undefined ? undefined : bool(values["create-session"], "create-session"),
      allowUnboundSession: values["allow-unbound-session"] === undefined ? undefined : bool(values["allow-unbound-session"], "allow-unbound-session"),
      expectedSession: values["expected-session"] ?? values.expectedSession,
      candidateSessionId: values["candidate-session-id"] ?? values.candidateSessionId,
      candidateSessionFile: values["candidate-session-file"] ?? values.candidateSessionFile,
      replaceSession: values["replace-session"] === undefined ? undefined : bool(values["replace-session"], "replace-session"),
      replacementMode: values["replacement-mode"] ?? values.replacementMode,
      replacementAuthorizationPath: values["replacement-authorization-file"],
      replacementAuthorizationDigest: values["replacement-authorization-digest"],
      currentBindingPath: values["current-binding-path"],
      currentBindingDigest: values["current-binding-digest"],
      attempt: values.attempt === undefined ? undefined : integer(values.attempt, "attempt"),
      attemptKind: values["attempt-kind"] ?? values.attemptKind,
      correctionOrdinal: values["correction-ordinal"] === undefined ? undefined : integer(values["correction-ordinal"], "correction-ordinal"),
      attemptAuthorizationPath: values["attempt-authorization-file"] ?? values.attemptAuthorizationFile,
      attemptAuthorizationDigest: values["attempt-authorization-digest"] ?? values.attemptAuthorizationDigest,
      suspensionAvailable: values["suspension-available"] === undefined ? undefined : bool(values["suspension-available"], "suspension-available"),
      waitPath: values["wait-path"] ?? values.waitPath,
      contextEvidence,
      providerUsage: undefined,
    });
  } else if (command === "result") {
    const action = values._[0];
    if (action !== "acknowledge") throw new Error("result requires acknowledge");
    result = await coordinator.acknowledgeResult({
      capsulePath: values.capsule,
      acknowledgementSourcePath: values["acknowledgement-file"],
      acknowledgementSourceDigest: values["acknowledgement-digest"],
      acknowledgedBy: values["acknowledged-by"] ?? values.acknowledgedBy,
    });
  } else if (command === "status") {
    result = await coordinator.status({
      phaseKey: values["phase-key"] ?? values.phaseKey,
      workPackageKey: values["work-package-key"] ?? values.workPackageKey,
      jobKey: values["job-key"] ?? values.jobKey,
    });
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  return { exitCode: exitCodeFor(result), result };
}

function exitCodeFor(result) {
  if (result?.status === "STOPPED" || result?.status === "FAIL" || result?.status === "FAILED" || result?.status === "UNKNOWN" || result?.status === "UNAVAILABLE") return 1;
  if (result?.dispatchStatus === "FAIL" || result?.dispatchStatus === "UNKNOWN") return 1;
  if (result?.stopCode && result.status !== "AWAITING_SESSION_BINDING") return 1;
  return 0;
}

export { HELP, execute, parseArgs };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const outcome = await execute(process.argv.slice(2));
    if (outcome.result?.status !== "HELP") process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "STOPPED", code: error.code ?? "E_RUNTIME", reason: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
