import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_RECORDS_ROOT,
  MAX_RECORD_BYTES,
  createConfigurationDraft,
  createQuestionnaire,
  deriveActiveConfiguration,
  confirmConfiguration,
  canonicalRecordBytes,
} from "../skills/deliberate-delegate/scripts/lib/project-config.mjs";
import {
  answerQuestion,
  inspectQuestion,
  listQuestions,
  openQuestion,
  questionDirectoryIdentity,
  withdrawQuestion,
} from "../skills/deliberate-delegate/scripts/lib/question-queue.mjs";
import {
  RuntimeCoordinator,
  canonicalSessionScope,
  deriveSessionScope,
  dispatchRole,
  inspectSessionBindings,
  confirmSessionBinding,
  acknowledgeResult,
  runtimeStatus,
} from "../skills/deliberate-delegate/scripts/lib/runtime-coordinator.mjs";
import { validateInvocationContract } from "../skills/deliberate-delegate/scripts/lib/job-controller.mjs";
import { evaluateCorrection, sha256Bytes } from "../skills/deliberate-delegate/scripts/lib/lifecycle-core.mjs";
import { validateResultCapsule } from "../skills/deliberate-delegate/scripts/lib/result-capsule.mjs";
import { HELP, execute } from "../skills/deliberate-delegate/scripts/dd-runtime.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(source, "tests", ".dd-runtime-scratch");

async function fixture() {
  await fs.mkdir(scratch, { recursive: true });
  return fs.mkdtemp(path.join(scratch, "fixture-"));
}

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.replaceAll("\\", "/").split("/"));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return relative;
}

async function withFixture(fn) {
  const root = await fixture();
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function answers({ plannerAdapter = "local-fixture", plannerProviderFamily = "other", plannerSessionMode = "create", plannerContinuityPolicy = "phase_scoped", plannerPermissionProfile = "read-only", executorAdapter = "local-fixture", executorProviderFamily = "other", executorSessionScope = "work_package_scoped", executorPermissionProfile = "workspace-write", noCommit = "instruction_only", maxCorrections = 2, hostWaitCapability = "described_equivalent" } = {}) {
  return {
    planningLead: { modelLabel: "lead-model", effort: "high", hostSurface: "outer-orchestration" },
    planner2: { adapterIdentifier: plannerAdapter, modelLabel: "planner-model", effort: "high", permissionProfile: plannerPermissionProfile, providerFamily: plannerProviderFamily, continuityPolicy: plannerContinuityPolicy, sessionMode: plannerSessionMode },
    executor: { adapterIdentifier: executorAdapter, modelLabel: "executor-model", effort: "high", permissionProfile: executorPermissionProfile, providerFamily: executorProviderFamily, noCommit, sessionScope: executorSessionScope },
    defaultTimeout: 5000,
    correctionPolicy: { maxCorrections },
    hostWaitCapability,
  };
}

async function configuredRoot(root, options = {}) {
  const draft = await createConfigurationDraft({ root, version: 1, answers: answers(options) });
  const confirmed = await confirmConfiguration({ root, version: 1, digest: draft.digest, confirmedBy: "planning-lead" });
  assert.equal(confirmed.status, "CREATED");
  return { draft, confirmed };
}

function invocationContract({ role = "executor", providerFamily = "other", adapterIdentifier = "local-fixture" } = {}) {
  const settings = {
    modelLabel: { outcome: "not_applicable", capability: "not_transported" },
    effort: { outcome: "not_applicable", capability: "not_transported" },
    permissionProfile: { outcome: "not_applicable", capability: "not_transported" },
  };
  if (role === "executor") settings.noCommit = { outcome: "not_applicable", capability: "not_transported" };
  if (role === "planner-2" && providerFamily === "claude") {
    settings.modelLabel = { outcome: "verified_requested", flag: "--model", value: "planner-model", form: "separate" };
    settings.effort = { outcome: "verified_requested", flag: "--effort", value: "high", form: "separate" };
    settings.permissionProfile = { outcome: "verified_requested", flag: "--read-only", form: "presence" };
    settings.autocompact = { outcome: "verified_requested", flag: "--autocompact", value: "400k", form: "separate" };
  }
  if (role === "executor" && providerFamily === "claude") {
    settings.modelLabel = { outcome: "verified_requested", flag: "--model", value: "executor-model", form: "separate" };
    settings.effort = { outcome: "verified_requested", flag: "--effort", value: "high", form: "separate" };
    settings.permissionProfile = { outcome: "unverified", reason: "adapter-parser/default_absence:acceptEdits" };
  }
  if (providerFamily === "codex") {
    const permissionProfile = role === "planner-2" ? "read-only" : "workspace-write";
    settings.modelLabel = { outcome: "verified_requested", flag: "--model", value: role === "planner-2" ? "planner-model" : "executor-model", form: "separate" };
    settings.effort = { outcome: "verified_requested", flag: "--effort", value: "high", form: "separate" };
    settings.permissionProfile = permissionProfile === "read-only"
      ? { outcome: "verified_requested", flag: "--read-only", form: "presence" }
      : { outcome: "verified_requested", flag: "--sandbox", value: "workspace-write", form: "separate" };
  }
  if (adapterIdentifier === "contract-fixture") {
    settings.modelLabel = { outcome: "verified_requested", flag: "--model", value: role === "planner-2" ? "planner-model" : "executor-model", form: "separate" };
    settings.effort = { outcome: "verified_requested", flag: "--effort", value: "high", form: "separate" };
    settings.permissionProfile = { outcome: "verified_requested", flag: "--permission-profile", value: role === "planner-2" ? "read-only" : "workspace-write", form: "separate" };
  }
  return { schemaVersion: "dd.invocation-contract.v1", version: 1, settings };
}

function adapterEnvelope(options = {}) {
  return {
    schemaVersion: "dd.adapter-envelope.v1",
    effectiveWorkingDirectory: ".",
    cwdMode: "inherits_process",
    adapterContract: null,
    invocationContract: invocationContract(options),
  };
}

function adapterCode(resultPath, result, { exit = 0, count = true } = {}) {
  const countCode = count ? "fs.appendFileSync('dispatch-count','1');" : "";
  return `const fs=require('fs');${countCode}fs.writeFileSync(${JSON.stringify(resultPath)},${JSON.stringify(JSON.stringify(result))});setTimeout(()=>process.exit(${exit}),30);`;
}

function seededCounterAdapterCode(resultPath, result, { counterPath = "provider-launch-counter", exit = 0 } = {}) {
  return `const fs=require('fs');const p=${JSON.stringify(counterPath)};const n=Number(fs.readFileSync(p,'utf8'));if(!Number.isInteger(n)||n<0)process.exit(61);fs.writeFileSync(p,String(n+1));fs.writeFileSync(${JSON.stringify(resultPath)},${JSON.stringify(JSON.stringify(result))});setTimeout(()=>process.exit(${exit}),30);`;
}

async function claudeRelayFixture(root, resultPath, result, { exit = 0, count = true } = {}) {
  const countCode = count ? "fs.appendFileSync('dispatch-count','1');" : "";
  const script = `const fs=require('fs');const argv=process.argv.slice(2);for(let i=0;i<argv.length;i+=1){const token=argv[i];if(token==='--'){process.exit(41);}if(token==='--model'||token==='--effort'||token==='--permission-profile'||token==='--autocompact'){if(token==='--autocompact'&&argv[i+1]!=='400k'){process.exit(42);}if(i+1>=argv.length||argv[i+1].startsWith('--')){process.exit(43);}i+=1;continue;}if(token==='--read-only'){continue;}if(token.startsWith('--autocompact=')){process.exit(44);}process.exit(45);}${countCode}fs.writeFileSync(${JSON.stringify(resultPath)},${JSON.stringify(JSON.stringify(result))});setTimeout(()=>process.exit(${exit}),30);`;
  const relative = "claude-relay-fixture.cjs";
  await write(root, relative, script);
  return path.join(root, relative);
}

async function codexRelayFixture(root, resultPath, result, { exit = 0, count = true } = {}) {
  const countCode = count ? "fs.appendFileSync('dispatch-count','1');" : "";
  const script = `const fs=require('fs');const argv=process.argv.slice(2);let model=0,effort=0,sandbox=null,readOnly=0,session=null;for(let i=0;i<argv.length;i+=1){const token=argv[i];const next=()=>{if(i+1>=argv.length||argv[i+1].startsWith('--'))process.exit(43);i+=1;return argv[i];};if(token==='--'){process.exit(41);}if(token==='--model'){model+=1;next();continue;}if(token==='--effort'){effort+=1;next();continue;}if(token==='--sandbox'){if(sandbox!==null)process.exit(44);sandbox=next();continue;}if(token==='--read-only'){readOnly+=1;continue;}if(token==='--session'){if(session!==null)process.exit(45);session=next();continue;}if(token==='--lane'||token==='--permission-mode'||token==='--dangerously-skip-permissions'||token==='--permission-profile'){process.exit(46);}process.exit(47);}if(model!==1||effort!==1||readOnly>1||(readOnly===1&&sandbox!==null)||(sandbox!==null&&sandbox!=='workspace-write'&&sandbox!=='read-only'))process.exit(48);${countCode}fs.writeFileSync(${JSON.stringify(resultPath)},${JSON.stringify(JSON.stringify(result))});setTimeout(()=>process.exit(${exit}),30);`;
  const relative = "codex-relay-fixture.cjs";
  await write(root, relative, script);
  return path.join(root, relative);
}

function resultPath(jobKey, attempt) {
  return `${DEFAULT_RECORDS_ROOT}/runtime/jobs/${jobKey}/attempt-${String(attempt).padStart(2, "0")}/result.json`;
}

async function writeBindingChain(root, { role = "executor", scope = "work-package:phase-1/wp-a", versions = 10 } = {}) {
  const scopeDirectory = `${DEFAULT_RECORDS_ROOT}/runtime/bindings/${role}/${sha256Bytes(scope)}`;
  let supersedes = null;
  const records = [];
  for (let version = 1; version <= versions; version += 1) {
    const record = {
      schemaVersion: "dd.session-binding.v1",
      version,
      lifecycle: "BOUND",
      publicRole: role,
      controllerRole: role === "planner-2" ? "planner" : "executor",
      scope,
      sessionId: `session-${version}`,
      provider: "local-fixture",
      sourceResultPath: `source-${version}.json`,
      sourceResultDigest: "0".repeat(64),
      dispatchIdentityHash: null,
      confirmedBy: "fixture",
      confirmationSource: "fixture",
      supersedes,
    };
    const relative = `${scopeDirectory}/binding.v${version}.json`;
    const bytes = canonicalRecordBytes(record);
    await write(root, relative, bytes);
    supersedes = sha256Bytes(bytes);
    records.push({ relative, digest: supersedes, record });
  }
  return { scope, scopeDirectory, records };
}

test("AC-2/AC-3/AC-4: questionnaire, immutable configuration versions, confirmation, supersession, and forbidden authority fields", async () => {
  await withFixture(async (root) => {
    const questionnaire = await createQuestionnaire({ root });
    assert.deepEqual(questionnaire.askedFields.planningLead, ["modelLabel", "effort", "hostSurface"]);
    assert.deepEqual(questionnaire.askedFields.planner2, ["adapterIdentifier", "modelLabel", "effort", "permissionProfile", "providerFamily", "continuityPolicy", "sessionMode"]);
    assert.deepEqual(questionnaire.askedFields.executor, ["adapterIdentifier", "modelLabel", "effort", "permissionProfile", "providerFamily", "noCommit", "sessionScope"]);
    assert.deepEqual(questionnaire.askedFields.scalar, ["defaultTimeout", "correctionPolicy.maxCorrections", "hostWaitCapability"]);
    assert.equal(questionnaire.derived.roleVocabulary["planner-2"], "planner");
    assert.equal(questionnaire.derived.suspensionStatus, "unknown");
    assert.equal(Object.keys(questionnaire).includes("phaseAuthorization"), false);

    const first = await createConfigurationDraft({ root, version: 1, answers: answers() });
    const confirmedFirst = await confirmConfiguration({ root, version: 1, digest: first.digest, confirmedBy: "planning-lead" });
    assert.equal(confirmedFirst.configuration.schemaVersion, "dd.project-config.v1");
    assert.equal((await confirmConfiguration({ root, version: 1, digest: first.digest, confirmedBy: "planning-lead" })).status, "REUSED");
    assert.equal((await deriveActiveConfiguration({ root })).active.version, 1);
    const replay = await createConfigurationDraft({ root, version: 1, answers: answers() });
    assert.equal(replay.status, "REUSED");
    const autoVersion = await createConfigurationDraft({ root, answers: answers({ plannerAdapter: "auto-version" }) });
    assert.equal(autoVersion.record.version, 2);
    assert.equal(autoVersion.record.supersedes, first.digest);
    await confirmConfiguration({ root, version: 2, digest: autoVersion.digest, confirmedBy: "planning-lead" });

    const second = await createConfigurationDraft({ root, version: 3, answers: answers({ plannerAdapter: "local-fixture-v2" }), supersedes: autoVersion.digest });
    await confirmConfiguration({ root, version: 3, digest: second.digest, confirmedBy: "planning-lead" });
    const active = await deriveActiveConfiguration({ root });
    assert.equal(active.active.version, 3);
    assert.equal(active.supersededDigests.includes(autoVersion.digest), true);
    await assert.rejects(createConfigurationDraft({ root, version: 3, answers: answers({ plannerAdapter: "different" }), supersedes: autoVersion.digest }), /contradict/);
    await assert.rejects(createConfigurationDraft({ root, version: 4, answers: { ...answers(), phaseAuthorization: "approve" }, supersedes: second.digest }), /authority field/);
  });
});

test("AC-5/AC-6: question queue preserves UTF-8 verbatim bytes, is append-only, and fails closed at the complete-record ceiling", async () => {
  await withFixture(async (root) => {
    const opened = await openQuestion({ root, questionKey: "q-unicode", text: "ما هو المسار؟\r\nKeep exact", intendedRespondent: "user", reason: "initialization", phaseId: "phase-01", workPackageId: "wp-01" });
    assert.equal(opened.status, "CREATED");
    const answered = await answerQuestion({ root, questionKey: "q-unicode", answer: "الإجابة\r\nverbatim" });
    assert.equal(answered.status, "CREATED");
    const answerReplay = await answerQuestion({ root, questionKey: "q-unicode", answer: "الإجابة\r\nverbatim" });
    assert.equal(answerReplay.status, "REUSED");
    await assert.rejects(answerQuestion({ root, questionKey: "q-unicode", answer: "different" }), /contradictory|both an answer/);
    const inspected = await inspectQuestion({ root, questionKey: "q-unicode" });
    assert.equal(inspected.state, "ANSWERED");
    assert.equal(inspected.answer.value.answer, "الإجابة\r\nverbatim");

    await openQuestion({ root, questionKey: "q-withdraw", text: "withdraw?", intendedRespondent: "user", reason: "test" });
    const withdrawn = await withdrawQuestion({ root, questionKey: "q-withdraw", reason: "not applicable" });
    assert.equal(withdrawn.status, "CREATED");
    await assert.rejects(answerQuestion({ root, questionKey: "q-withdraw", answer: "late" }), /both an answer and a withdrawal/);
    assert.equal((await listQuestions({ root })).map((item) => item.state).sort().join(","), "ANSWERED,WITHDRAWN");

    const nearLimitText = "x".repeat(MAX_RECORD_BYTES - 600);
    const near = await openQuestion({ root, questionKey: "q-near-limit", text: nearLimitText, intendedRespondent: "user", reason: "size" });
    assert.equal(near.status, "CREATED");
    const tooLarge = await openQuestion({ root, questionKey: "q-too-large", text: "x".repeat(MAX_RECORD_BYTES), intendedRespondent: "user", reason: "size" });
    assert.equal(tooLarge.status, "STOPPED_VERBATIM_TOO_LARGE");
    await assert.rejects(fs.stat(path.join(root, tooLarge.path)));
  });
});

test("AC-1/AC-7/AC-8/AC-9/AC-10/AC-11/AC-12: one coordinator dispatches both roles, binds exactly one session, and reuses deterministic artifacts", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "approved immutable brief\n");
    const firstPath = resultPath("wp-runtime", 1);
    const first = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
       workPackageKey: "wp-1",
      jobKey: "wp-runtime",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "session-1" })],
       adapterEnvelope: adapterEnvelope(),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(first.runtimeStatus, "AWAITING_SESSION_BINDING");
    assert.equal(first.dispatchCount, 1);
    assert.equal(first.capsule.role, "executor");
    const bindingsBefore = await inspectSessionBindings({ root, role: "executor" });
    assert.equal(bindingsBefore[0].bindings.length, 0);
    const bound = await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-1", sessionId: "session-1", sourceResultPath: firstPath, confirmedBy: "planning-lead" });
    assert.equal(bound.record.sessionId, "session-1");

    const secondPath = resultPath("wp-runtime", 2);
    const correctionAuthorizationPath = "correction-authority.txt";
    await write(root, correctionAuthorizationPath, "correction authority\n");
    const correctionAuthorizationDigest = sha256Bytes("correction authority\n");
    const second = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "wp-runtime",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(secondPath, { status: "completed", exitCode: 0, sessionId: "session-1" })],
       adapterEnvelope: adapterEnvelope(),
      attempt: 2,
      attemptKind: "correction",
      correctionOrdinal: 1,
      attemptAuthorizationPath: correctionAuthorizationPath,
      attemptAuthorizationDigest: correctionAuthorizationDigest,
      waitPath: "described_equivalent",
    });
    assert.equal(second.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD");
    assert.equal(second.dispatchCount, 1);
    assert.equal(second.capsule.role, "executor");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "11");

    const reused = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "wp-runtime",
      attempt: 2,
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(secondPath, { status: "completed", exitCode: 0, sessionId: "session-1" })],
      adapterEnvelope: adapterEnvelope(),
      attemptKind: "correction",
      correctionOrdinal: 1,
      attemptAuthorizationPath: correctionAuthorizationPath,
      attemptAuthorizationDigest: correctionAuthorizationDigest,
      waitPath: "described_equivalent",
    });
    assert.equal(reused.status, "REUSED", JSON.stringify(reused));
    assert.equal(reused.dispatchCount, 0);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "11");
  });
});

test("AC-7/AC-11: zero or contradictory session evidence stops safely, and a technical failure binds before retry", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const ambiguousPath = resultPath("ambiguous", 1);
    const ambiguous = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "ambiguous",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(ambiguousPath, { status: "completed", exitCode: 0, sessionId: "one", threadId: "two" })],
      adapterEnvelope: adapterEnvelope(),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(ambiguous.stopCode, "STOPPED_AMBIGUOUS_SESSION");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");

    const failedPath = `${DEFAULT_RECORDS_ROOT}/runtime/jobs/technical/attempt-01/result.json`;
    const failed = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "technical",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(failedPath, { status: "failed", exitCode: 9, sessionId: "technical-session" }, { exit: 9 })],
      adapterEnvelope: adapterEnvelope(),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(failed.runtimeStatus, "AWAITING_SESSION_BINDING");
    assert.equal(failed.status, "FAIL");
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-1", sessionId: "technical-session", sourceResultPath: failedPath, confirmedBy: "planning-lead" });
    const replayAuthorizationPath = "technical-replay-authority.txt";
    await write(root, replayAuthorizationPath, "technical replay authority\n");
    const replayAuthorizationDigest = sha256Bytes("technical replay authority\n");
    const retryPath = `${DEFAULT_RECORDS_ROOT}/runtime/jobs/technical/attempt-02/result.json`;
    const retry = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "technical",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(retryPath, { status: "completed", exitCode: 0, sessionId: "technical-session" })],
      adapterEnvelope: adapterEnvelope(),
      attempt: 2,
      attemptKind: "technical_replay",
      attemptAuthorizationPath: replayAuthorizationPath,
      attemptAuthorizationDigest: replayAuthorizationDigest,
      waitPath: "described_equivalent",
    });
    assert.equal(retry.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(retry));
  });
});

test("AC-8/AC-11/AC-13: changed brief identity, invalid envelope, and missing Claude autocompact stop before provider launch", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const firstPath = resultPath("contradiction", 1);
    const first = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "contradiction",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "s" })],
      adapterEnvelope: adapterEnvelope(),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(first.runtimeStatus, "AWAITING_SESSION_BINDING");
    await write(root, "changed-brief.md", "different brief\n");
    const changed = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "contradiction",
      briefPath: "changed-brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "new" })],
      adapterEnvelope: adapterEnvelope(),
      attempt: 2,
      attemptKind: "correction",
      correctionOrdinal: 1,
      attemptAuthorizationPath: "brief.md",
      attemptAuthorizationDigest: sha256Bytes("brief\n"),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(changed.stopCode, "STOPPED_BINDING_PENDING_CONTRADICTION");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");

    const invalid = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-invalid",
      jobKey: "invalid-envelope",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" })],
      adapterEnvelope: { schemaVersion: "dd.adapter-envelope.v1", effectiveWorkingDirectory: "../outside", cwdMode: "inherits_process", adapterContract: null },
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(invalid.stopCode, "STOPPED_INVALID_ENVELOPE");

    const claudeRoot = await fixture();
    try {
      await configuredRoot(claudeRoot, { plannerAdapter: "claude-delegate", plannerProviderFamily: "claude" });
      await write(claudeRoot, "brief.md", "brief\n");
      const missing = await dispatchRole({
        root: claudeRoot,
        role: "planner-2",
        phaseKey: "phase-1",
        workPackageKey: "wp-1",
        jobKey: "claude-missing",
        briefPath: "brief.md",
        adapter: process.execPath,
        adapterIdentifier: "claude-delegate",
        args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false })],
        adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "claude-delegate" }),
        createSession: true,
        waitPath: "described_equivalent",
      });
      assert.equal(missing.stopCode, "STOPPED_AUTO_COMPACTION_UNVERIFIED");
      await assert.rejects(fs.stat(path.join(claudeRoot, "dispatch-count")));
    } finally {
      await fs.rm(claudeRoot, { recursive: true, force: true });
    }
  });
});

test("AC-10: derived status reports configuration, human-answer, binding, ready, and result stops without Phase/Step state", async () => {
  await withFixture(async (root) => {
    assert.equal((await runtimeStatus({ root })).status, "AWAITING_CONFIGURATION_CONFIRMATION");
    await configuredRoot(root);
    assert.equal((await runtimeStatus({ root })).status, "READY_FOR_AUTHORIZED_DISPATCH");
    await openQuestion({ root, questionKey: "status-q", text: "answer?", intendedRespondent: "user", reason: "status" });
    assert.equal((await runtimeStatus({ root })).status, "AWAITING_HUMAN_ANSWER");
    await answerQuestion({ root, questionKey: "status-q", answer: "done" });
    assert.equal((await runtimeStatus({ root })).status, "READY_FOR_AUTHORIZED_DISPATCH");
    await write(root, "brief.md", "brief\n");
    const firstPath = resultPath("wp-runtime", 1);
    const first = await dispatchRole({
      root,
      role: "planner-2",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "wp-runtime",
      briefPath: "brief.md",
       adapter: process.execPath,
       adapterIdentifier: "local-fixture",
       args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "planner-session" })],
       adapterEnvelope: adapterEnvelope({ role: "planner-2" }),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(first.runtimeStatus, "AWAITING_SESSION_BINDING");
    assert.equal((await runtimeStatus({ root })).status, "AWAITING_SESSION_BINDING");
    await confirmSessionBinding({ root, role: "planner-2", scope: "phase:phase-1", sessionId: "planner-session", sourceResultPath: firstPath, confirmedBy: "planning-lead" });
     const secondPath = resultPath("wp-runtime", 2);
     await write(root, "status-correction-authority.txt", "status correction authority\n");
     const statusCorrectionDigest = sha256Bytes("status correction authority\n");
    const second = await dispatchRole({
      root,
      role: "planner-2",
      phaseKey: "phase-1",
      workPackageKey: "wp-1",
      jobKey: "wp-runtime",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(secondPath, { status: "completed", exitCode: 0, sessionId: "planner-session" })],
       adapterEnvelope: adapterEnvelope({ role: "planner-2" }),
       attempt: 2,
       attemptKind: "correction",
       correctionOrdinal: 1,
       attemptAuthorizationPath: "status-correction-authority.txt",
       attemptAuthorizationDigest: statusCorrectionDigest,
      waitPath: "described_equivalent",
    });
    assert.equal(second.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(second));
    assert.equal((await runtimeStatus({ root, phaseKey: "phase-1", workPackageKey: "wp-1", jobKey: "wp-runtime" })).status, "RESULT_READY_FOR_PLANNING_LEAD");
    const docs = await fs.readdir(path.join(root, DEFAULT_RECORDS_ROOT));
    assert.equal(docs.includes("phaseState"), false);
    assert.equal(docs.includes("stepState"), false);
  });
});

test("AC-9/AC-14: coordinator event records are versioned, digest-linked, and create-once", async () => {
  await withFixture(async (root) => {
    const coordinator = new RuntimeCoordinator({ root });
    const draft = await coordinator.createConfiguration({ version: 1, answers: answers() });
    await coordinator.confirmConfiguration({ version: 1, digest: draft.digest, confirmedBy: "planning-lead" });
    await coordinator.openQuestion({ questionKey: "event-q", text: "event question", intendedRespondent: "user", reason: "event" });
    await coordinator.answerQuestion({ questionKey: "event-q", answer: "event answer" });
    const eventRoot = path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "events");
    const events = await fs.readdir(eventRoot);
    const types = [];
    for (const file of events) types.push(JSON.parse(await fs.readFile(path.join(eventRoot, file), "utf8")).eventType);
    assert.equal(types.includes("config_versioned"), true);
    assert.equal(types.includes("question_opened"), true);
    assert.equal(types.includes("answer_recorded"), true);
    const before = events.length;
    await coordinator.answerQuestion({ questionKey: "event-q", answer: "event answer" });
    assert.equal((await fs.readdir(eventRoot)).length, before);
  });
});

test("C-1: bindings are scoped to phase/work-package and project-scoped Planner 2 continuity is explicit", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const plannerFirstPath = resultPath("scope-planner-1", 1);
    const plannerFirst = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "scope-planner-1", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(plannerFirstPath, { status: "completed", exitCode: 0, sessionId: "planner-phase-1" })], adapterEnvelope: adapterEnvelope({ role: "planner-2" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(plannerFirst.runtimeStatus, "AWAITING_SESSION_BINDING");
    await confirmSessionBinding({ root, role: "planner-2", scope: "phase:phase-1", sessionId: "planner-phase-1", sourceResultPath: plannerFirstPath, confirmedBy: "planning-lead" });
    const phaseTwo = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-2", workPackageKey: "wp-a", jobKey: "scope-planner-2", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(resultPath("scope-planner-2", 1), { status: "completed", exitCode: 0, sessionId: "wrong" })], adapterEnvelope: adapterEnvelope({ role: "planner-2" }), expectedSession: "planner-phase-1", createSession: true, waitPath: "described_equivalent" });
    assert.equal(phaseTwo.stopCode, "STOPPED_SESSION_MISMATCH");

    const executorFirstPath = resultPath("scope-executor-a", 1);
    const executorFirst = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "scope-executor-a", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(executorFirstPath, { status: "completed", exitCode: 0, sessionId: "executor-wp-a" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "executor-wp-a", sourceResultPath: executorFirstPath, confirmedBy: "planning-lead" });
    const otherWorkPackage = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-b", jobKey: "scope-executor-b", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(resultPath("scope-executor-b", 1), { status: "completed", exitCode: 0, sessionId: "wrong" })], adapterEnvelope: adapterEnvelope(), expectedSession: "executor-wp-a", createSession: true, waitPath: "described_equivalent" });
    assert.equal(otherWorkPackage.stopCode, "STOPPED_SESSION_MISMATCH");
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { plannerContinuityPolicy: "project_scoped" });
    await write(root, "brief.md", "brief\n");
    const firstPath = resultPath("project-planner-1", 1);
    const first = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "project-planner-1", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "project-session" })], adapterEnvelope: adapterEnvelope({ role: "planner-2" }), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "planner-2", scope: "project", sessionId: "project-session", sourceResultPath: firstPath, confirmedBy: "planning-lead" });
    const secondPath = resultPath("project-planner-2", 1);
    const second = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-2", workPackageKey: "wp-b", jobKey: "project-planner-2", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(secondPath, { status: "completed", exitCode: 0, sessionId: "project-session" })], adapterEnvelope: adapterEnvelope({ role: "planner-2" }), waitPath: "described_equivalent" });
    assert.equal(second.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD");
  });
});

test("C-1: bind_existing verifies the candidate session before creating a pending binding", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { plannerSessionMode: "bind_existing" });
    await write(root, "brief.md", "brief\n");
    await write(root, "candidate-session.txt", "existing-session\n");
    const sourcePath = resultPath("bind-existing", 1);
    const first = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "bind-existing", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(sourcePath, { status: "completed", exitCode: 0, sessionId: "existing-session" })], adapterEnvelope: adapterEnvelope({ role: "planner-2" }), candidateSessionFile: "candidate-session.txt", waitPath: "described_equivalent" });
    assert.equal(first.runtimeStatus, "AWAITING_SESSION_BINDING");
    assert.equal(first.observedSessionIds[0], "existing-session");
    await confirmSessionBinding({ root, role: "planner-2", scope: "phase:phase-1", sessionId: "existing-session", sourceResultPath: sourcePath, confirmedBy: "planning-lead" });
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { plannerSessionMode: "bind_existing" });
    await write(root, "brief.md", "brief\n");
    const sourcePath = resultPath("bind-mismatch", 1);
    const mismatch = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "bind-mismatch", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(sourcePath, { status: "completed", exitCode: 0, sessionId: "other-session" })], adapterEnvelope: adapterEnvelope({ role: "planner-2" }), candidateSessionId: "candidate-session", waitPath: "described_equivalent" });
    assert.equal(mismatch.stopCode, "STOPPED_SESSION_MISMATCH");
    assert.equal((await inspectSessionBindings({ root, role: "planner-2" }))[0].scopes.length, 0);
  });
});

test("C-2: Claude gating uses providerFamily and actual argv, never caller telemetry", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { plannerAdapter: "claude-delegate", plannerProviderFamily: "claude" });
    await write(root, "brief.md", "brief\n");
    const missing = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "claude-telemetry-only", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "claude-delegate", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false })], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "claude-delegate" }), contextEvidence: { requestedSetting: "--autocompact 400k", preflightStatus: "verified" }, createSession: true, waitPath: "described_equivalent" });
    assert.equal(missing.stopCode, "STOPPED_AUTO_COMPACTION_UNVERIFIED");
    const malformed = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "claude-duplicate", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "claude-delegate", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false }), "--autocompact", "400k", "--autocompact=400k"], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "claude-delegate" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(malformed.stopCode, "STOPPED_AUTO_COMPACTION_UNVERIFIED");
    const exactPath = resultPath("claude-exact", 1);
    const relayScript = await claudeRelayFixture(root, exactPath, { status: "completed", exitCode: 0, sessionId: "claude-session" });
    const exact = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "claude-exact", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "claude-delegate", args: [relayScript, "--model", "planner-model", "--effort", "high", "--read-only", "--autocompact", "400k"], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "claude-delegate" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(exact.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(exact));
    assert.equal(exact.capsule.contextManagement.preflightStatus, "verified");
    assert.equal(exact.capsule.contextManagement.providerApplication, "unknown");
    assert.equal(exact.capsule.invocationEvidence.meaning, "requested_argv_only");
  });
});

test("C-3: replacement requires immutable evidence and preserves it through the superseding binding", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const firstPath = resultPath("replacement", 1);
    const first = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replacement", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "old-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    const oldBinding = await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "old-session", sourceResultPath: firstPath, confirmedBy: "planning-lead" });
    const missing = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replacement-missing", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(resultPath("replacement-missing", 1), { status: "completed", exitCode: 0, sessionId: "new-session" })], adapterEnvelope: adapterEnvelope(), replaceSession: true, replacementMode: "create", createSession: true, currentBindingPath: oldBinding.path, currentBindingDigest: oldBinding.digest, waitPath: "described_equivalent" });
    assert.equal(missing.stopCode, "STOPPED_REPLACEMENT_AUTHORIZATION");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
    const authorizationPath = "replacement-authority.txt";
    await write(root, authorizationPath, "direct user authority evidence\n");
    const authorizationDigest = sha256Bytes("direct user authority evidence\n");
    const replacementPath = resultPath("replacement", 2);
    const replacement = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replacement", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(replacementPath, { status: "completed", exitCode: 0, sessionId: "new-session" })], adapterEnvelope: adapterEnvelope(), replaceSession: true, replacementMode: "create", createSession: true, replacementAuthorizationPath: authorizationPath, replacementAuthorizationDigest: authorizationDigest, currentBindingPath: oldBinding.path, currentBindingDigest: oldBinding.digest, attempt: 2, attemptKind: "correction", correctionOrdinal: 1, attemptAuthorizationPath: authorizationPath, attemptAuthorizationDigest: authorizationDigest, waitPath: "described_equivalent" });
    assert.equal(replacement.runtimeStatus, "AWAITING_SESSION_BINDING");
    assert.match(replacement.bindingRequestPath, /pending-replacement\.v2\.json$/);
    const newBinding = await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", replaceSession: true, replacementAuthorizationPath: authorizationPath, replacementAuthorizationDigest: authorizationDigest, sessionId: "new-session", sourceResultPath: replacementPath, confirmedBy: "planning-lead" });
    assert.equal(newBinding.record.supersedes, oldBinding.digest);
    assert.deepEqual(newBinding.record.replacementAuthorization, { path: authorizationPath, sha256: authorizationDigest });
  });
});

test("C-4: configuration confirmation accepts one linear chain and rejects dangling or non-linear heads", async () => {
  await withFixture(async (root) => {
    const first = await createConfigurationDraft({ root, version: 1, answers: answers() });
    await confirmConfiguration({ root, version: 1, digest: first.digest, confirmedBy: "planning-lead" });
    const second = await createConfigurationDraft({ root, version: 2, answers: answers({ plannerAdapter: "planner-v2" }), supersedes: first.digest });
    await confirmConfiguration({ root, version: 2, digest: second.digest, confirmedBy: "planning-lead" });
    assert.equal((await deriveActiveConfiguration({ root })).active.version, 2);
    const nonLinear = await createConfigurationDraft({ root, version: 3, answers: answers({ plannerAdapter: "planner-v3" }), supersedes: first.digest });
    await assert.rejects(confirmConfiguration({ root, version: 3, digest: nonLinear.digest, confirmedBy: "planning-lead" }), /stale|non-linear|current confirmed head/);
  });

  await withFixture(async (root) => {
    const first = await createConfigurationDraft({ root, version: 1, answers: answers() });
    await confirmConfiguration({ root, version: 1, digest: first.digest, confirmedBy: "planning-lead" });
    const dangling = await createConfigurationDraft({ root, version: 2, answers: answers({ plannerAdapter: "dangling" }), supersedes: "f".repeat(64) });
    const confirmationPath = `${DEFAULT_RECORDS_ROOT}/configuration/configuration.v2.confirmation.json`;
    await write(root, confirmationPath, JSON.stringify({ schemaVersion: "dd.project-config-confirmation.v1", version: 2, lifecycle: "CONFIRMED", configurationPath: dangling.path, configurationDigest: dangling.digest, confirmedBy: "fixture", confirmationSource: "fixture", supersedes: "f".repeat(64) }));
    await assert.rejects(deriveActiveConfiguration({ root }), /dangling|non-linear|contradict/);
  });
});

test("C-5: distinct mechanical stops in one attempt are content-addressed and event-typed", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const invalidEnvelope = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "two-stops", attempt: 1, briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: [], adapterEnvelope: { schemaVersion: "dd.adapter-envelope.v1", effectiveWorkingDirectory: "../outside", cwdMode: "inherits_process", adapterContract: null }, createSession: true, waitPath: "described_equivalent" });
    const invalidArgs = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "two-stops", attempt: 1, briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: "not-an-array", adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(invalidEnvelope.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(invalidEnvelope));
    assert.equal(invalidArgs.stopCode, "STOPPED_INVALID_ARGS", JSON.stringify(invalidArgs));
    assert.notEqual(invalidEnvelope.stopPath, invalidArgs.stopPath);
    const stops = await fs.readdir(path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "jobs", "two-stops", "attempt-01", "stops"));
    assert.equal(stops.length, 2, JSON.stringify({ stops, invalidEnvelope, invalidArgs }));
    const events = await fs.readdir(path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "events"));
    const eventTypes = [];
    for (const file of events) eventTypes.push(JSON.parse(await fs.readFile(path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "events", file), "utf8")).eventType);
    assert.equal(eventTypes.includes("envelope_rejected"), true);
    assert.equal(eventTypes.includes("stop_recorded"), true);
  });
});

test("C-6: answer and withdrawal use one atomic terminal file and a concurrent winner is preserved", async () => {
  await withFixture(async (root) => {
    await openQuestion({ root, questionKey: "atomic-question", text: "choose", intendedRespondent: "user", reason: "race", phaseId: "phase-1", workPackageId: "wp-a" });
    const outcomes = await Promise.allSettled([
      answerQuestion({ root, questionKey: "atomic-question", answer: "answer" }),
      withdrawQuestion({ root, questionKey: "atomic-question", reason: "withdraw" }),
    ]);
    assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
    const directory = path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "questions", questionDirectoryIdentity("atomic-question"));
    const files = await fs.readdir(directory);
    assert.equal(files.includes("terminal.json"), true);
    assert.equal(files.includes("answer.json"), false);
    assert.equal(files.includes("withdrawal.json"), false);
    const listed = await listQuestions({ root });
    assert.equal(listed[0].state === "ANSWERED" || listed[0].state === "WITHDRAWN", true);
  });
});

test("C-7: scoped questions stop only applicable work and result acknowledgement clears stale result-ready", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await openQuestion({ root, questionKey: "phase-one-question", text: "phase one", intendedRespondent: "user", reason: "scope", phaseId: "phase-1" });
    const unrelatedPath = resultPath("unrelated-phase", 1);
    const unrelated = await dispatchRole({ root, role: "executor", phaseKey: "phase-2", workPackageKey: "wp-b", jobKey: "unrelated-phase", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(unrelatedPath, { status: "completed", exitCode: 0, sessionId: "unrelated" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(unrelated.runtimeStatus, "AWAITING_SESSION_BINDING");
  });

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await openQuestion({ root, questionKey: "applicable-question", text: "phase one", intendedRespondent: "user", reason: "scope", phaseId: "phase-1", workPackageId: "wp-a" });
    const blocked = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "blocked-by-question", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(blocked.stopCode, "AWAITING_HUMAN_ANSWER");
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const firstPath = resultPath("ack-job", 1);
    const first = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "ack-job", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "ack-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "ack-session", sourceResultPath: firstPath, confirmedBy: "planning-lead" });
    const secondPath = resultPath("ack-job", 2);
    await write(root, "ack-correction-authority.txt", "ack correction authority\n");
    const ackCorrectionDigest = sha256Bytes("ack correction authority\n");
    const second = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "ack-job", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(secondPath, { status: "completed", exitCode: 0, sessionId: "ack-session" })], adapterEnvelope: adapterEnvelope(), attempt: 2, attemptKind: "correction", correctionOrdinal: 1, attemptAuthorizationPath: "ack-correction-authority.txt", attemptAuthorizationDigest: ackCorrectionDigest, waitPath: "described_equivalent" });
    assert.equal(second.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD");
    assert.equal((await runtimeStatus({ root, phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "ack-job" })).status, "RESULT_READY_FOR_PLANNING_LEAD");
    await write(root, "acknowledgement.txt", "handled by planning lead\n");
    const acknowledged = await acknowledgeResult({ root, capsulePath: second.capsulePath, acknowledgementSourcePath: "acknowledgement.txt", acknowledgedBy: "planning-lead" });
    assert.equal(acknowledged.record.schemaVersion, "dd.result-acknowledgement.v1");
    assert.equal((await runtimeStatus({ root, phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "ack-job" })).status, "READY_FOR_AUTHORIZED_DISPATCH");
    assert.equal((await runtimeStatus({ root })).status, "READY_FOR_AUTHORIZED_DISPATCH");
    await assert.rejects(acknowledgeResult({ root, capsulePath: second.capsulePath, acknowledgementSourcePath: "brief.md", acknowledgedBy: "different" }), /contradict/);
  });
});

test("C-7: malformed legacy dual question evidence is a scoped contradiction", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await openQuestion({ root, questionKey: "legacy-dual", text: "legacy", intendedRespondent: "user", reason: "fixture", phaseId: "phase-1", workPackageId: "wp-a" });
    const directory = path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "questions", questionDirectoryIdentity("legacy-dual"));
    await fs.writeFile(path.join(directory, "answer.json"), JSON.stringify({ schemaVersion: "dd.answer.v1", questionKey: "legacy-dual", answer: "a", source: "human_input" }));
    await fs.writeFile(path.join(directory, "withdrawal.json"), JSON.stringify({ schemaVersion: "dd.question-withdrawal.v1", questionKey: "legacy-dual", reason: "w" }));
    const listed = await listQuestions({ root });
    assert.equal(listed[0].state, "CONTRADICTORY");
    const blocked = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "legacy-blocked", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(blocked.stopCode, "STOPPED_QUESTION_CONTRADICTION");
  });
});

test("C-6/C-7: a key-mismatched question record remains a scoped stop", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await openQuestion({ root, questionKey: "directory-key", text: "key", intendedRespondent: "user", reason: "fixture", phaseId: "phase-1", workPackageId: "wp-a" });
    const directory = path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "questions", questionDirectoryIdentity("directory-key"));
    const questionPath = path.join(directory, "question.json");
    const malformedKey = { schemaVersion: "dd.question.v1", questionKey: "different-key", questionText: "key", intendedRespondent: "user", reason: "fixture", phaseId: "phase-1", workPackageId: "wp-a" };
    await fs.writeFile(questionPath, JSON.stringify(malformedKey));
    const listed = await listQuestions({ root });
    assert.equal(listed[0].state, "CONTRADICTORY");
    const blocked = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "key-mismatch", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(blocked.stopCode, "STOPPED_QUESTION_CONTRADICTION");
  });
});

test("C-8: noCommit is a non-attesting classification, not transport enforcement", async () => {
  await withFixture(async (root) => {
    await assert.rejects(createConfigurationDraft({ root, version: 1, answers: answers({ noCommit: "transport_enforced" }) }), /must be one of/);
    const draft = await createConfigurationDraft({ root, version: 1, answers: answers({ noCommit: "adapter_policy_declared" }) });
    assert.equal(draft.record.answers.executor.noCommit, "adapter_policy_declared");
  });
});

test("C-9: confirmed role profiles constrain caller duplicates and bind requested argv evidence", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const contradictions = [
      ["adapterIdentifier", "caller-adapter"],
      ["providerFamily", "claude"],
      ["modelLabel", "caller-model"],
      ["effort", "low"],
      ["permissionProfile", "read-only"],
      ["noCommit", "adapter_policy_declared"],
    ];
    for (const [field, value] of contradictions) {
      const result = await dispatchRole({
        root,
        role: "executor",
        phaseKey: "phase-1",
        workPackageKey: "wp-a",
        jobKey: `profile-${field}`,
        briefPath: "brief.md",
        adapter: process.execPath,
        adapterIdentifier: "local-fixture",
        [field]: value,
        args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false })],
        adapterEnvelope: adapterEnvelope(),
        createSession: true,
        waitPath: "described_equivalent",
      });
      assert.equal(result.stopCode, "STOPPED_CONFIGURATION_PROFILE_CONTRADICTION", JSON.stringify(result));
    }
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { executorAdapter: "contract-fixture" });
    await write(root, "brief.md", "brief\n");
    const resultPathValue = resultPath("contract", 1);
    const relayScript = await claudeRelayFixture(root, resultPathValue, { status: "completed", exitCode: 0, sessionId: "contract-session" });
    const valid = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-a",
      jobKey: "contract",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "contract-fixture",
      args: [relayScript, "--model", "executor-model", "--effort", "high", "--permission-profile", "workspace-write"],
      adapterEnvelope: adapterEnvelope({ adapterIdentifier: "contract-fixture" }),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(valid.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(valid));
    assert.equal(valid.capsule.invocationEvidence.meaning, "requested_argv_only");
    assert.equal(valid.capsule.invocationEvidence.providerEnforcement, "unknown");
    const active = await deriveActiveConfiguration({ root });
    const request = JSON.parse(await fs.readFile(path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "jobs", "contract", "attempt-01", "dispatch-request.v1.json"), "utf8"));
    assert.equal(request.configurationPath, active.active.configurationPath);
    assert.equal(request.configurationDigest, active.active.configurationDigest);
    assert.equal(request.roleProfile.adapterIdentifier, "contract-fixture");
    assert.equal(request.roleProfile.noCommit, "instruction_only");
    assert.equal(typeof request.invocationContractDigest, "string");

    const badContract = adapterEnvelope({ adapterIdentifier: "contract-fixture" });
    badContract.invocationContract.settings.modelLabel.value = "wrong-model";
    const mismatched = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-b",
      jobKey: "contract-mismatch",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "contract-fixture",
      args: [relayScript, "--model", "executor-model", "--effort", "high", "--permission-profile", "workspace-write"],
      adapterEnvelope: badContract,
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(mismatched.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(mismatched));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");

    const unsupportedNotApplicable = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-c",
      jobKey: "contract-not-applicable",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "contract-fixture",
      args: [relayScript, "--model", "executor-model", "--effort", "high", "--permission-profile", "workspace-write"],
      adapterEnvelope: adapterEnvelope(),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(unsupportedNotApplicable.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(unsupportedNotApplicable));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });
});

test("C-10: correction ordinals, immutable authorization, replay limits, and identity drift fail closed", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const firstPath = resultPath("correction-policy", 1);
    const first = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "correction-policy", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "correction-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "correction-session", sourceResultPath: firstPath, confirmedBy: "planning-lead" });
    const authorityPath = "correction-policy-authority.txt";
    await write(root, authorityPath, "correction policy authority\n");
    const authorityDigest = sha256Bytes("correction policy authority\n");
    const common = { root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(resultPath("never", 1), { status: "completed", exitCode: 0, sessionId: "never" }, { count: false })], adapterEnvelope: adapterEnvelope(), waitPath: "described_equivalent" };
    const missingAuth = await dispatchRole({ ...common, jobKey: "correction-missing-auth", attempt: 2, attemptKind: "correction", correctionOrdinal: 1 });
    assert.equal(missingAuth.stopCode, "STOPPED_ATTEMPT_AUTHORIZATION");
    const overLimit = await dispatchRole({ ...common, jobKey: "correction-over-limit", attempt: 4, attemptKind: "correction", correctionOrdinal: 3, attemptAuthorizationPath: authorityPath, attemptAuthorizationDigest: authorityDigest });
    assert.equal(overLimit.stopCode, "STOPPED_CORRECTION_LIMIT");
    const skippedOrdinal = await dispatchRole({ ...common, jobKey: "correction-skipped", attempt: 3, attemptKind: "correction", correctionOrdinal: 2, attemptAuthorizationPath: authorityPath, attemptAuthorizationDigest: authorityDigest });
    assert.equal(skippedOrdinal.stopCode, "STOPPED_CORRECTION_POLICY");
    const arbitraryAttempt = await dispatchRole({ ...common, jobKey: "correction-arbitrary", attempt: 999999, attemptKind: "correction", correctionOrdinal: 1, attemptAuthorizationPath: authorityPath, attemptAuthorizationDigest: authorityDigest });
    assert.equal(arbitraryAttempt.stopCode, "STOPPED_CORRECTION_POLICY");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const failedPath = resultPath("replay-policy", 1);
    const failed = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replay-policy", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(failedPath, { status: "failed", exitCode: 9, sessionId: "replay-session" }, { exit: 9 })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "replay-session", sourceResultPath: failedPath, confirmedBy: "planning-lead" });
    const authorityPath = "replay-policy-authority.txt";
    await write(root, authorityPath, "replay policy authority\n");
    const authorityDigest = sha256Bytes("replay policy authority\n");
    const replayPath = resultPath("replay-policy", 2);
    const replay = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replay-policy", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(replayPath, { status: "completed", exitCode: 0, sessionId: "replay-session" })], adapterEnvelope: adapterEnvelope(), attempt: 2, attemptKind: "technical_replay", attemptAuthorizationPath: authorityPath, attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(replay.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(replay));
    const secondReplay = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replay-policy", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(resultPath("replay-policy", 3), { status: "completed", exitCode: 0, sessionId: "replay-session" })], adapterEnvelope: adapterEnvelope(), attempt: 3, attemptKind: "technical_replay", attemptAuthorizationPath: authorityPath, attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(secondReplay.stopCode, "STOPPED_TECHNICAL_REPLAY_LIMIT", JSON.stringify(secondReplay));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "11");
  });

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await write(root, "changed-brief.md", "changed\n");
    const failedPath = resultPath("replay-drift", 1);
    await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replay-drift", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(failedPath, { status: "failed", exitCode: 9, sessionId: "drift-session" }, { exit: 9 })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "drift-session", sourceResultPath: failedPath, confirmedBy: "planning-lead" });
    await write(root, "replay-drift-authority.txt", "replay drift authority\n");
    const drift = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "replay-drift", briefPath: "changed-brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(resultPath("replay-drift", 2), { status: "completed", exitCode: 0, sessionId: "drift-session" })], adapterEnvelope: adapterEnvelope(), attempt: 2, attemptKind: "technical_replay", attemptAuthorizationPath: "replay-drift-authority.txt", attemptAuthorizationDigest: sha256Bytes("replay drift authority\n"), waitPath: "described_equivalent" });
    assert.equal(drift.stopCode, "STOPPED_TECHNICAL_REPLAY_CONTRADICTION", JSON.stringify(drift));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });
});

test("C-11: Claude uses the separated claude-delegate grammar and stops unknown capabilities honestly", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { plannerAdapter: "claude-delegate", plannerProviderFamily: "claude" });
    await write(root, "brief.md", "brief\n");
    const equalsPath = resultPath("claude-equals", 1);
    const equalsScript = await claudeRelayFixture(root, equalsPath, { status: "completed", exitCode: 0, sessionId: "never" });
    const equals = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "claude-equals", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "claude-delegate", args: [equalsScript, "--model", "planner-model", "--effort", "high", "--read-only", "--autocompact=400k"], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "claude-delegate" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(equals.stopCode, "STOPPED_AUTO_COMPACTION_UNVERIFIED", JSON.stringify(equals));
    const postPath = resultPath("claude-post-terminator", 1);
    const postScript = await claudeRelayFixture(root, postPath, { status: "completed", exitCode: 0, sessionId: "never" });
    const post = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "claude-post-terminator", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "claude-delegate", args: [postScript, "--", "--model", "planner-model", "--effort", "high", "--read-only", "--autocompact", "400k"], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "claude-delegate" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(post.stopCode, "STOPPED_AUTO_COMPACTION_UNVERIFIED", JSON.stringify(post));
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { plannerAdapter: "unknown-claude", plannerProviderFamily: "claude" });
    await write(root, "brief.md", "brief\n");
    const resultPathValue = resultPath("unknown-claude", 1);
    const relayScript = await claudeRelayFixture(root, resultPathValue, { status: "completed", exitCode: 0, sessionId: "never" });
    const unknown = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "unknown-claude", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "unknown-claude", args: [relayScript, "--model", "planner-model", "--effort", "high", "--read-only", "--autocompact", "400k"], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "unknown-claude" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(unknown.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(unknown));
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });
});

test("C-12: binding chains, pending replacements, and attempt status use numeric and connected records", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const chain = await writeBindingChain(root);
    const inspected = await inspectSessionBindings({ root, role: "executor" });
    const scope = inspected[0].scopes.find((entry) => entry.scope === chain.scope);
    assert.equal(scope.bindings.at(-1).version, 10);
    const dispatchResultPath = resultPath("numeric-dispatch", 1);
    const dispatched = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "numeric-dispatch", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(dispatchResultPath, { status: "completed", exitCode: 0, sessionId: "session-10" })], adapterEnvelope: adapterEnvelope(), waitPath: "described_equivalent" });
    assert.equal(dispatched.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(dispatched));
    const attemptOne = path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "jobs", "numeric-dispatch", "attempt-01");
    for (const attempt of [9, 10]) {
      await fs.cp(attemptOne, path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "jobs", "numeric-dispatch", `attempt-${String(attempt).padStart(2, "0")}`), { recursive: true });
    }
    const status = await runtimeStatus({ root, phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "numeric-dispatch" });
    assert.equal(status.status, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(status));
    assert.match(status.records[0].path, /jobs\/numeric-dispatch\/attempt-10\/controller\/capsule\.v1\.json$/);
  });

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const chain = await writeBindingChain(root, { versions: 2 });
    const invalid = { ...chain.records[1].record, supersedes: "0".repeat(64) };
    await write(root, chain.records[1].relative, canonicalRecordBytes(invalid));
    const stopped = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "invalid-chain", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false })], adapterEnvelope: adapterEnvelope(), waitPath: "described_equivalent" });
    assert.equal(stopped.stopCode, "STOPPED_BINDING_CHAIN", JSON.stringify(stopped));
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const seedPath = resultPath("pending-seed", 1);
    const seed = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "pending-seed", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(seedPath, { status: "completed", exitCode: 0, sessionId: "old-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    const oldBinding = await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "old-session", sourceResultPath: seedPath, confirmedBy: "planning-lead" });
    await write(root, "pending-authority.txt", "pending authority\n");
    const authorizationDigest = sha256Bytes("pending authority\n");
    const replacementPath = resultPath("pending-replacement", 1);
    const replacementOptions = {
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-a",
      jobKey: "pending-replacement",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", adapterCode(replacementPath, { status: "completed", exitCode: 0, sessionId: "new-session" })],
      adapterEnvelope: adapterEnvelope(),
      replaceSession: true,
      replacementMode: "create",
      createSession: true,
      replacementAuthorizationPath: "pending-authority.txt",
      replacementAuthorizationDigest: authorizationDigest,
      currentBindingPath: oldBinding.path,
      currentBindingDigest: oldBinding.digest,
      waitPath: "described_equivalent",
    };
    const pending = await dispatchRole(replacementOptions);
    assert.equal(pending.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(pending));
    const replay = await dispatchRole({ ...replacementOptions, attempt: 1, attemptKind: "initial" });
    assert.equal(replay.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(replay));
    assert.equal(replay.dispatchCount, 0);
    assert.equal(replay.bindingRequestPath, pending.bindingRequestPath);
    assert.equal(replay.bindingRequestDigest, pending.bindingRequestDigest);
    const divergent = await dispatchRole({ ...replacementOptions, jobKey: "pending-divergent", args: ["-e", adapterCode(resultPath("pending-divergent", 1), { status: "completed", exitCode: 0, sessionId: "different-session" })] });
    assert.equal(divergent.stopCode, "STOPPED_BINDING_PENDING_CONTRADICTION", JSON.stringify(divergent));
    const pendingRecord = JSON.parse(await fs.readFile(path.join(root, pending.bindingRequestPath), "utf8"));
    await write(root, `${DEFAULT_RECORDS_ROOT}/runtime/bindings/executor/${sha256Bytes("work-package:phase-1/wp-a")}/pending-replacement.v3.json`, canonicalRecordBytes({ ...pendingRecord, replacementVersion: 3 }));
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", replaceSession: true, replacementVersion: 2, replacementAuthorizationPath: "pending-authority.txt", replacementAuthorizationDigest: authorizationDigest, sessionId: "new-session", sourceResultPath: replacementPath, confirmedBy: "planning-lead" }), /pending replacement|stale|fork|next numeric/);
  });
});

test("C-13: Codex and Claude capability mappings are measured, paired, and fail closed", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { plannerAdapter: "codex-delegate", plannerProviderFamily: "codex", executorAdapter: "codex-delegate", executorProviderFamily: "codex" });
    await write(root, "brief.md", "brief\n");
    const plannerPath = resultPath("codex-planner", 1);
    const plannerRelay = await codexRelayFixture(root, plannerPath, { status: "completed", exitCode: 0, sessionId: "codex-planner-session" });
    const planner = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "codex-planner", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "codex-delegate", args: [plannerRelay, "--model", "planner-model", "--effort", "high", "--read-only"], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "codex", adapterIdentifier: "codex-delegate" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(planner.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(planner));
    assert.equal(planner.capsule.invocationEvidence.verified.permissionProfile.outcome, "verified_requested");
    assert.equal(planner.capsule.invocationEvidence.meaning, "requested_argv_only");
    const executorPath = resultPath("codex-executor", 1);
    const executorRelay = await codexRelayFixture(root, executorPath, { status: "completed", exitCode: 0, sessionId: "codex-executor-session" });
    const executor = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "codex-executor", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "codex-delegate", args: [executorRelay, "--model", "executor-model", "--effort", "high", "--sandbox", "workspace-write"], adapterEnvelope: adapterEnvelope({ role: "executor", providerFamily: "codex", adapterIdentifier: "codex-delegate" }), createSession: true, waitPath: "described_equivalent" });
    assert.equal(executor.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(executor));
    assert.equal(executor.capsule.invocationEvidence.meaning, "requested_argv_only");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "11");

    await confirmSessionBinding({ root, role: "planner-2", scope: "phase:phase-1", sessionId: "codex-planner-session", sourceResultPath: plannerPath, confirmedBy: "planning-lead" });
    const resumePath = resultPath("codex-planner-resume", 1);
    const resumeRelay = await codexRelayFixture(root, resumePath, { status: "completed", exitCode: 0, sessionId: "codex-planner-session" });
    const resumed = await dispatchRole({ root, role: "planner-2", phaseKey: "phase-1", workPackageKey: "wp-b", jobKey: "codex-planner-resume", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "codex-delegate", args: [resumeRelay, "--model", "planner-model", "--effort", "high", "--read-only", "--session", "codex-planner-session"], adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "codex", adapterIdentifier: "codex-delegate" }), waitPath: "described_equivalent" });
    assert.equal(resumed.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(resumed));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "111");
  });

  for (const scenario of [
    { name: "codex-family-mismatch", role: "executor", config: { executorAdapter: "codex-delegate", executorProviderFamily: "claude" }, adapterIdentifier: "codex-delegate", providerFamily: "claude", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false })] },
    { name: "anthropic-alias", role: "planner-2", config: { plannerAdapter: "anthropic-relay", plannerProviderFamily: "claude" }, adapterIdentifier: "anthropic-relay", providerFamily: "claude", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }), "--model", "planner-model", "--effort", "high", "--read-only", "--autocompact", "400k"] },
    { name: "unknown-adapter", role: "executor", config: { executorAdapter: "unknown-delegate", executorProviderFamily: "other" }, adapterIdentifier: "unknown-delegate", providerFamily: "other", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false })] },
  ]) {
    await withFixture(async (root) => {
      await configuredRoot(root, scenario.config);
      await write(root, "brief.md", "brief\n");
      const stopped = await dispatchRole({ root, role: scenario.role, phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: scenario.name, briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: scenario.adapterIdentifier, args: scenario.args, adapterEnvelope: adapterEnvelope({ role: scenario.role, providerFamily: scenario.providerFamily, adapterIdentifier: scenario.adapterIdentifier }), createSession: true, waitPath: "described_equivalent" });
      assert.equal(stopped.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(stopped));
      assert.match(String(stopped.reason), /capability|providerFamily|mapped|unverified/i);
      await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
    });
  }
});

test("C-13: contradictory permission selectors and dangerous configured modes never launch", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { executorAdapter: "codex-delegate", executorProviderFamily: "codex" });
    await write(root, "brief.md", "brief\n");
    const cases = [
      ["both-permission-flags", ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false }), "--model", "executor-model", "--effort", "high", "--read-only", "--sandbox", "danger-full-access"]],
      ["lane-alternative", ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "never" }, { count: false }), "--model", "executor-model", "--effort", "high", "--sandbox", "workspace-write", "--lane", "broad"]],
    ];
    for (const [jobKey, args] of cases) {
      const stopped = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey, briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "codex-delegate", args, adapterEnvelope: adapterEnvelope({ adapterIdentifier: "codex-delegate" }), createSession: true, waitPath: "described_equivalent" });
      assert.equal(stopped.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(stopped));
      assert.doesNotMatch(JSON.stringify(stopped), /verified_requested/);
    }
    await assert.rejects(createConfigurationDraft({ root, version: 2, answers: answers({ executorAdapter: "codex-delegate", executorProviderFamily: "codex", executorPermissionProfile: "danger-full-access" }) }), /dangerous|broader/);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });
});

test("C-14: physical attempts are consecutive while correction ordinals remain independent", async () => {
  async function requestSequence(root, jobKey) {
    const requests = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      requests.push(JSON.parse(await fs.readFile(path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "jobs", jobKey, `attempt-${String(attempt).padStart(2, "0")}`, "dispatch-request.v1.json"), "utf8")));
    }
    return requests;
  }

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const initialPath = resultPath("sequence-replay-first", 1);
    const initial = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-replay-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(initialPath, { status: "failed", exitCode: 9, sessionId: "sequence-a" }, { exit: 9 })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(initial.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(initial));
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "sequence-a", sourceResultPath: initialPath, confirmedBy: "planning-lead" });
    await write(root, "sequence-authority.txt", "authorized correction and replay\n");
    const authorityDigest = sha256Bytes("authorized correction and replay\n");
    const replayPath = resultPath("sequence-replay-first", 2);
    const replay = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-replay-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(replayPath, { status: "completed", exitCode: 0, sessionId: "sequence-a" })], adapterEnvelope: adapterEnvelope(), attemptKind: "technical_replay", attemptAuthorizationPath: "sequence-authority.txt", attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(replay.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(replay));
    for (const ordinal of [1, 2]) {
      const correctionPath = resultPath("sequence-replay-first", ordinal + 2);
      const correction = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-replay-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(correctionPath, { status: "completed", exitCode: 0, sessionId: "sequence-a" })], adapterEnvelope: adapterEnvelope(), attemptKind: "correction", correctionOrdinal: ordinal, attemptAuthorizationPath: "sequence-authority.txt", attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
      assert.equal(correction.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(correction));
    }
    const requests = await requestSequence(root, "sequence-replay-first");
    assert.deepEqual(requests.map((request) => [request.attempt, request.attemptKind, request.correctionOrdinal]), [[1, "initial", null], [2, "technical_replay", null], [3, "correction", 1], [4, "correction", 2]]);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1111");
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { maxCorrections: 3 });
    await write(root, "brief.md", "brief\n");
    const initialPath = resultPath("sequence-correction-first", 1);
    const initial = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-correction-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(initialPath, { status: "completed", exitCode: 0, sessionId: "sequence-b" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "sequence-b", sourceResultPath: initialPath, confirmedBy: "planning-lead" });
    await write(root, "sequence-b-authority.txt", "authorized sequence b\n");
    const authorityDigest = sha256Bytes("authorized sequence b\n");
    const correctionOnePath = resultPath("sequence-correction-first", 2);
    const correctionOne = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-correction-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(correctionOnePath, { status: "failed", exitCode: 9, sessionId: "sequence-b" }, { exit: 9 })], adapterEnvelope: adapterEnvelope(), attemptKind: "correction", correctionOrdinal: 1, attemptAuthorizationPath: "sequence-b-authority.txt", attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(correctionOne.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(correctionOne));
    const replayPath = resultPath("sequence-correction-first", 3);
    const replay = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-correction-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(replayPath, { status: "completed", exitCode: 0, sessionId: "sequence-b" })], adapterEnvelope: adapterEnvelope(), attemptKind: "technical_replay", attemptAuthorizationPath: "sequence-b-authority.txt", attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(replay.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(replay));
    const correctionTwoPath = resultPath("sequence-correction-first", 4);
    const correctionTwo = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-correction-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(correctionTwoPath, { status: "completed", exitCode: 0, sessionId: "sequence-b" })], adapterEnvelope: adapterEnvelope(), attemptKind: "correction", correctionOrdinal: 2, attemptAuthorizationPath: "sequence-b-authority.txt", attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(correctionTwo.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(correctionTwo));
    const correctionThreePath = resultPath("sequence-correction-first", 5);
    const correctionThree = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-correction-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(correctionThreePath, { status: "failed", exitCode: 9, sessionId: "sequence-b" }, { exit: 9 })], adapterEnvelope: adapterEnvelope(), attemptKind: "correction", correctionOrdinal: 3, attemptAuthorizationPath: "sequence-b-authority.txt", attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(correctionThree.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(correctionThree));
    const secondReplay = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "sequence-correction-first", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(resultPath("sequence-correction-first", 6), { status: "completed", exitCode: 0, sessionId: "sequence-b" })], adapterEnvelope: adapterEnvelope(), attemptKind: "technical_replay", attemptAuthorizationPath: "sequence-b-authority.txt", attemptAuthorizationDigest: authorityDigest, waitPath: "described_equivalent" });
    assert.equal(secondReplay.stopCode, "STOPPED_TECHNICAL_REPLAY_LIMIT", JSON.stringify(secondReplay));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "11111");
    const requests = await requestSequence(root, "sequence-correction-first");
    assert.deepEqual(requests.map((request) => [request.attempt, request.attemptKind, request.correctionOrdinal]), [[1, "initial", null], [2, "correction", 1], [3, "technical_replay", null], [4, "correction", 2]]);
  });
});

test("C-14: zero correction allowance preserves initial and permits only an applicable replay", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { maxCorrections: 0 });
    await write(root, "brief.md", "brief\n");
    const pathOne = resultPath("zero-correction", 1);
    await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "zero-correction", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(pathOne, { status: "completed", exitCode: 0, sessionId: "zero-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "zero-session", sourceResultPath: pathOne, confirmedBy: "planning-lead" });
    await write(root, "zero-authority.txt", "zero correction authority\n");
    const digest = sha256Bytes("zero correction authority\n");
    const blocked = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "zero-correction", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode("never.json", { status: "completed", exitCode: 0, sessionId: "zero-session" }, { count: false })], adapterEnvelope: adapterEnvelope(), attemptKind: "correction", correctionOrdinal: 1, attemptAuthorizationPath: "zero-authority.txt", attemptAuthorizationDigest: digest, waitPath: "described_equivalent" });
    assert.equal(blocked.stopCode, "STOPPED_CORRECTION_LIMIT", JSON.stringify(blocked));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { maxCorrections: 0 });
    await write(root, "brief.md", "brief\n");
    const pathOne = resultPath("zero-replay", 1);
    await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "zero-replay", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(pathOne, { status: "failed", exitCode: 9, sessionId: "zero-replay-session" }, { exit: 9 })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "zero-replay-session", sourceResultPath: pathOne, confirmedBy: "planning-lead" });
    await write(root, "zero-replay-authority.txt", "zero replay authority\n");
    const digest = sha256Bytes("zero replay authority\n");
    const pathTwo = resultPath("zero-replay", 2);
    const replay = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "zero-replay", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(pathTwo, { status: "completed", exitCode: 0, sessionId: "zero-replay-session" })], adapterEnvelope: adapterEnvelope(), attemptKind: "technical_replay", attemptAuthorizationPath: "zero-replay-authority.txt", attemptAuthorizationDigest: digest, waitPath: "described_equivalent" });
    assert.equal(replay.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(replay));
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "11");
  });
});

test("C-15: pending history resolves by exact request references across replacement v2 and v3", async () => {
  await withFixture(async (root) => {
    const scope = "work-package:phase-1/wp-a";
    const scopeDirectory = path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "bindings", "executor", sha256Bytes(scope));
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await write(root, "replacement-authority.txt", "replacement authority\n");
    const authorizationDigest = sha256Bytes("replacement authority\n");

    const firstPath = resultPath("binding-history-initial", 1);
    const first = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "binding-history-initial", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(firstPath, { status: "completed", exitCode: 0, sessionId: "history-old" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(first.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(first));
    const bindingOne = await confirmSessionBinding({ root, role: "executor", scope, sessionId: "history-old", sourceResultPath: firstPath, confirmedBy: "planning-lead" });
    assert.equal(bindingOne.record.bindingRequestPath, first.bindingRequestPath);
    assert.equal(bindingOne.record.bindingRequestDigest, first.bindingRequestDigest);

    const replace = async (version, current, jobKey, sessionId) => {
      const sourcePath = resultPath(jobKey, 1);
      const pending = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey, briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(sourcePath, { status: "completed", exitCode: 0, sessionId })], adapterEnvelope: adapterEnvelope(), replaceSession: true, replacementMode: "create", createSession: true, replacementAuthorizationPath: "replacement-authority.txt", replacementAuthorizationDigest: authorizationDigest, currentBindingPath: current.path, currentBindingDigest: current.digest, waitPath: "described_equivalent" });
      assert.equal(pending.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(pending));
      assert.match(pending.bindingRequestPath, new RegExp(`pending-replacement\\.v${version}\\.json$`));
      const next = await confirmSessionBinding({ root, role: "executor", scope, replaceSession: true, replacementVersion: version, replacementAuthorizationPath: "replacement-authority.txt", replacementAuthorizationDigest: authorizationDigest, sessionId, sourceResultPath: sourcePath, confirmedBy: "planning-lead" });
      assert.equal(next.record.bindingRequestPath, pending.bindingRequestPath);
      assert.equal(next.record.bindingRequestDigest, pending.bindingRequestDigest);
      assert.equal(next.record.supersedes, current.digest);
      return next;
    };

    const bindingTwo = await replace(2, bindingOne, "binding-history-replacement-2", "history-new-2");
    const afterTwo = (await inspectSessionBindings({ root, role: "executor" }))[0].scopes.find((entry) => entry.scope === scope);
    assert.equal(afterTwo.pending, null);
    assert.equal(afterTwo.replacementPending, null);
    const statusAfterTwo = await runtimeStatus({ root, phaseKey: "phase-1", workPackageKey: "wp-a" });
    assert.notEqual(statusAfterTwo.status, "STOPPED");
    assert.notEqual(statusAfterTwo.status, "AWAITING_SESSION_BINDING");

    const bindingThree = await replace(3, bindingTwo, "binding-history-replacement-3", "history-new-3");
    assert.equal(bindingThree.record.supersedes, bindingTwo.digest);
    const afterThree = (await inspectSessionBindings({ root, role: "executor" }))[0].scopes.find((entry) => entry.scope === scope);
    assert.equal(afterThree.pending, null);
    assert.equal(afterThree.replacementPending, null);
    const status = await runtimeStatus({ root, phaseKey: "phase-1", workPackageKey: "wp-a" });
    assert.notEqual(status.status, "STOPPED");
    assert.notEqual(status.status, "AWAITING_SESSION_BINDING");
    const retained = await fs.readdir(scopeDirectory);
    assert.deepEqual(retained.sort(), ["binding.v1.json", "binding.v2.json", "binding.v3.json", "pending-replacement.v2.json", "pending-replacement.v3.json", "pending.v1.json"].sort());
  });
});

test("C-15: stale, dangling, contradictory, and multiple unresolved pending records stop", async () => {
  async function seed(root) {
    const scope = "work-package:phase-1/wp-a";
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await write(root, "replacement-authority.txt", "replacement authority\n");
    const authorizationDigest = sha256Bytes("replacement authority\n");
    const sourcePath = resultPath("pending-seed", 1);
    const first = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "pending-seed", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(sourcePath, { status: "completed", exitCode: 0, sessionId: "seed-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    const binding = await confirmSessionBinding({ root, role: "executor", scope, sessionId: "seed-session", sourceResultPath: sourcePath, confirmedBy: "planning-lead" });
    return { scope, binding, authorizationDigest };
  }

  for (const kind of ["stale", "dangling", "multiple"]) {
    await withFixture(async (root) => {
      const { scope, binding, authorizationDigest } = await seed(root);
      const sourcePath = resultPath(`manual-${kind}`, 1);
      const sourceBytes = Buffer.from(JSON.stringify({ status: "completed", exitCode: 0, sessionId: `manual-${kind}-session` }));
      await write(root, sourcePath, sourceBytes);
      const pendingRecord = (version, predecessorDigest = binding.digest) => ({
        schemaVersion: "dd.session-binding-request.v1",
        lifecycle: "PENDING",
        publicRole: "executor",
        controllerRole: "executor",
        scope,
        sessionId: `manual-${kind}-${version}`,
        provider: "local-fixture",
        sourceResultPath: sourcePath,
        sourceResultDigest: sha256Bytes(sourceBytes),
        dispatchIdentityHash: null,
        attemptKind: "initial",
        correctionOrdinal: null,
        attemptAuthorization: null,
        capsulePath: null,
        resultValidation: { valid: true },
        expectedSession: null,
        sessionMode: "create",
        replacement: true,
        replacementVersion: version,
        currentBindingPath: binding.path,
        currentBindingDigest: predecessorDigest,
        replacementAuthorization: { path: "replacement-authority.txt", sha256: authorizationDigest },
      });
      const directory = `${DEFAULT_RECORDS_ROOT}/runtime/bindings/executor/${sha256Bytes(scope)}`;
      if (kind === "stale") {
        await write(root, `${directory}/pending-replacement.v3.json`, canonicalRecordBytes(pendingRecord(3)));
        await assert.rejects(inspectSessionBindings({ root, role: "executor" }), /stale|fork|skip|next|dangling/);
      } else if (kind === "dangling") {
        await write(root, `${directory}/pending-replacement.v2.json`, canonicalRecordBytes(pendingRecord(2, "0".repeat(64))));
        const stopped = await runtimeStatus({ root, phaseKey: "phase-1", workPackageKey: "wp-a" });
        assert.equal(stopped.status, "STOPPED", JSON.stringify(stopped));
        assert.match(stopped.reason, /stale|fork|skip|next|dangling/);
      } else {
        await write(root, `${directory}/pending-replacement.v2.json`, canonicalRecordBytes(pendingRecord(2)));
        await write(root, `${directory}/pending-replacement.v3.json`, canonicalRecordBytes(pendingRecord(3)));
        await assert.rejects(inspectSessionBindings({ root, role: "executor" }), /multiple unresolved|stale|fork|dangling/);
      }
    });
  }

  await withFixture(async (root) => {
    const { scope, binding, authorizationDigest } = await seed(root);
    const directory = `${DEFAULT_RECORDS_ROOT}/runtime/bindings/executor/${sha256Bytes(scope)}`;
    const contradictory = {
      schemaVersion: "dd.session-binding.v1",
      version: 2,
      lifecycle: "BOUND",
      publicRole: "executor",
      controllerRole: "executor",
      scope,
      sessionId: "contradictory-session",
      provider: "local-fixture",
      sourceResultPath: "missing.json",
      sourceResultDigest: "0".repeat(64),
      bindingRequestPath: `${directory}/pending-replacement.v2.json`,
      bindingRequestDigest: "1".repeat(64),
      dispatchIdentityHash: null,
      confirmedBy: "fixture",
      confirmationSource: "fixture",
      supersedes: binding.digest,
      replacementAuthorization: { path: "replacement-authority.txt", sha256: authorizationDigest },
    };
    await write(root, `${directory}/binding.v2.json`, canonicalRecordBytes(contradictory));
    await assert.rejects(inspectSessionBindings({ root, role: "executor" }), /missing pending|request digest|exact pending/);
  });
});

test("C-16: semantic no-progress remains Planning-Lead-owned and is not emitted without structured policy input", async () => {
  const correctionPolicy = evaluateCorrection({ attempt: 1, priorDefects: ["C-16"], currentDefects: ["C-16"], relevantEvidenceChanged: false, meaningfulDelta: false });
  assert.equal(correctionPolicy.stopCode, "STOPPED_NO_PROGRESS");
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const initialPath = resultPath("no-progress", 1);
    await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "no-progress", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(initialPath, { status: "completed", exitCode: 0, sessionId: "no-progress-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    await confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/wp-a", sessionId: "no-progress-session", sourceResultPath: initialPath, confirmedBy: "planning-lead" });
    await write(root, "same-defect-authority.txt", "same blocking defect; no delta\n");
    const correctionPath = resultPath("no-progress", 2);
    const correction = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-a", jobKey: "no-progress", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(correctionPath, { status: "completed", exitCode: 0, sessionId: "no-progress-session" })], adapterEnvelope: adapterEnvelope(), attemptKind: "correction", correctionOrdinal: 1, attemptAuthorizationPath: "same-defect-authority.txt", attemptAuthorizationDigest: sha256Bytes("same blocking defect; no delta\n"), waitPath: "described_equivalent" });
    assert.equal(correction.runtimeStatus, "RESULT_READY_FOR_PLANNING_LEAD", JSON.stringify(correction));
    assert.doesNotMatch(JSON.stringify(correction.capsule), /STOPPED_NO_PROGRESS|semantic no-progress|meaningful delta/i);
    const workflow = await fs.readFile(path.join(source, "skills", "deliberate-delegate", "references", "workflow.md"), "utf8");
    assert.match(workflow, /Planning Lead applies the existing `evaluateCorrection` policy/);
    assert.match(workflow, /deterministic runtime verifies the immutable authorization/);
  });
});

test("C-17: runtime help and documentation expose measured mapping tiers and grammar truth", async () => {
  const help = await fs.readFile(path.join(source, "skills", "deliberate-delegate", "scripts", "dd-runtime.mjs"), "utf8");
  const runtimeDoc = await fs.readFile(path.join(source, "skills", "deliberate-delegate", "scripts", "dd-runtime.md"), "utf8");
  const providers = await fs.readFile(path.join(source, "skills", "deliberate-delegate", "references", "providers.md"), "utf8");
  const records = await fs.readFile(path.join(source, "skills", "deliberate-delegate", "references", "records.md"), "utf8");
  for (const text of [help, runtimeDoc, providers]) {
    assert.match(text, /claude-delegate/);
    assert.match(text, /codex-delegate/);
    assert.match(text, /unknown|unmapped/i);
    assert.match(text, /separated/);
    assert.match(text, /option terminator|`--` token/);
  }
  assert.match(providers, /technical replay is per Work Package\/job|per Work Package\/job/);
  assert.match(providers, /Claude Executor[\s\S]*acceptEdits[\s\S]*default/);
  assert.match(runtimeDoc, /Claude Executor[\s\S]*default[\s\S]*adapter_default/);
  assert.match(records, /bindingRequestPath/);
  assert.match(records, /Planning Lead owns the semantic no-progress[\s\S]*decision/);
  assert.doesNotMatch(runtimeDoc, /before the option terminator|tokens after `--` are rejected/);
  assert.doesNotMatch(providers, /before the option terminator/);
});

test("C-18: Claude Executor uses bounded adapter-default evidence and rejects permission alternatives", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { executorAdapter: "claude-delegate", executorProviderFamily: "claude" });
    await write(root, "brief.md", "brief\n");
    const resultPathValue = resultPath("claude-executor-default", 1);
    const relayScript = await claudeRelayFixture(root, resultPathValue, { status: "completed", exitCode: 0, sessionId: "claude-executor-session" });
    const dispatched = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-a",
      jobKey: "claude-executor-default",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "claude-delegate",
      args: [relayScript, "--model", "executor-model", "--effort", "high"],
      adapterEnvelope: adapterEnvelope({ role: "executor", providerFamily: "claude", adapterIdentifier: "claude-delegate" }),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(dispatched.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(dispatched));
    assert.equal(dispatched.capsule.invocationEvidence.meaning, "requested_argv_and_adapter_default");
    const permissionEvidence = dispatched.capsule.invocationEvidence.verified.permissionProfile;
    assert.equal(permissionEvidence.outcome, "unverified");
    assert.equal(permissionEvidence.evidence, "adapter_default");
    assert.equal(permissionEvidence.form, "default_absence");
    assert.equal(permissionEvidence.profile, "acceptEdits");
    assert.deepEqual(permissionEvidence.absentFlags, ["--read-only", "--dangerously-skip-permissions", "--permission-mode", "--sandbox", "--lane", "--permission-profile"]);
    assert.match(permissionEvidence.limitation, /provider application|OS sandboxing|no-commit enforcement/);
    assert.equal(dispatched.capsule.invocationEvidence.providerApplication, "unknown");
    assert.equal(dispatched.capsule.invocationEvidence.providerEnforcement, "unknown");
    assert.equal(dispatched.capsule.invocationContract.settings.permissionProfile.outcome, "unverified");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });

  const rejectedSelectors = [
    ["read-only", "--read-only"],
    ["dangerous", "--dangerously-skip-permissions"],
    ["permission-mode", "--permission-mode", "acceptEdits"],
    ["sandbox", "--sandbox", "workspace-write"],
    ["lane", "--lane", "normal"],
    ["permission-profile", "--permission-profile", "workspace-write"],
    ["equals", "--read-only=true"],
    ["terminator-hidden", "--", "--dangerously-skip-permissions"],
  ];
  for (const [name, ...selector] of rejectedSelectors) {
    await withFixture(async (root) => {
      await configuredRoot(root, { executorAdapter: "claude-delegate", executorProviderFamily: "claude" });
      await write(root, "brief.md", "brief\n");
      const resultPathValue = resultPath(`claude-executor-${name}`, 1);
      const relayScript = await claudeRelayFixture(root, resultPathValue, { status: "completed", exitCode: 0, sessionId: "never" });
      const stopped = await dispatchRole({
        root,
        role: "executor",
        phaseKey: "phase-1",
        workPackageKey: "wp-a",
        jobKey: `claude-executor-${name}`,
        briefPath: "brief.md",
        adapter: process.execPath,
        adapterIdentifier: "claude-delegate",
        args: [relayScript, "--model", "executor-model", "--effort", "high", ...selector],
        adapterEnvelope: adapterEnvelope({ role: "executor", providerFamily: "claude", adapterIdentifier: "claude-delegate" }),
        createSession: true,
        waitPath: "described_equivalent",
      });
      assert.equal(stopped.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(stopped));
      assert.equal(stopped.dispatchCount, 0, JSON.stringify(stopped));
      const stopRecord = JSON.parse(await fs.readFile(path.join(root, stopped.stopPath), "utf8"));
      assert.equal(stopRecord.code, "STOPPED_INVALID_ENVELOPE");
      assert.match(stopRecord.reason, /adapter-default|permission|terminator/i);
      await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
    });
  }

  for (const providerFamily of ["codex", "gemini", "other"]) {
    await withFixture(async (root) => {
      await configuredRoot(root, { executorAdapter: "claude-delegate", executorProviderFamily: providerFamily });
      await write(root, "brief.md", "brief\n");
      const resultPathValue = resultPath(`claude-executor-${providerFamily}-mismatch`, 1);
      const relayScript = await claudeRelayFixture(root, resultPathValue, { status: "completed", exitCode: 0, sessionId: "never" });
      const stopped = await dispatchRole({
        root,
        role: "executor",
        phaseKey: "phase-1",
        workPackageKey: "wp-a",
        jobKey: `claude-executor-${providerFamily}-mismatch`,
        briefPath: "brief.md",
        adapter: process.execPath,
        adapterIdentifier: "claude-delegate",
        args: [relayScript, "--model", "executor-model", "--effort", "high"],
        adapterEnvelope: adapterEnvelope({ role: "executor", providerFamily, adapterIdentifier: "claude-delegate" }),
        createSession: true,
        waitPath: "described_equivalent",
      });
      assert.equal(stopped.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(stopped));
      assert.equal(stopped.dispatchCount, 0, JSON.stringify(stopped));
      const stopRecord = JSON.parse(await fs.readFile(path.join(root, stopped.stopPath), "utf8"));
      assert.equal(stopRecord.code, "STOPPED_INVALID_ENVELOPE");
      assert.match(stopRecord.reason, /providerFamily|capability|mapped|unverified/i);
      await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
    });
  }
});

test("C-19: invocation evidence meaning is derived and validated against nested evidence", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { executorAdapter: "claude-delegate", executorProviderFamily: "claude" });
    await write(root, "brief.md", "brief\n");
    const resultPathValue = resultPath("claude-executor-meaning", 1);
    const relayScript = await claudeRelayFixture(root, resultPathValue, { status: "completed", exitCode: 0, sessionId: "claude-meaning-session" });
    const dispatched = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-a",
      jobKey: "claude-executor-meaning",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "claude-delegate",
      args: [relayScript, "--model", "executor-model", "--effort", "high"],
      adapterEnvelope: adapterEnvelope({ role: "executor", providerFamily: "claude", adapterIdentifier: "claude-delegate" }),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(dispatched.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(dispatched));
    const valid = await validateResultCapsule(dispatched.capsule, { root });
    assert.equal(valid.valid, true, JSON.stringify(valid));

    const requestedOnly = structuredClone(dispatched.capsule);
    requestedOnly.invocationEvidence.meaning = "requested_argv_only";
    const requestedOnlyValidation = await validateResultCapsule(requestedOnly, { root });
    assert.equal(requestedOnlyValidation.valid, false);
    assert.match(requestedOnlyValidation.errors.join(" "), /meaning|adapter-default/i);

    const unknownMeaning = structuredClone(dispatched.capsule);
    unknownMeaning.invocationEvidence.meaning = "caller_invented";
    const unknownMeaningValidation = await validateResultCapsule(unknownMeaning, { root });
    assert.equal(unknownMeaningValidation.valid, false);
    assert.match(unknownMeaningValidation.errors.join(" "), /meaning|unknown/i);

    const unknownEvidence = structuredClone(dispatched.capsule);
    unknownEvidence.invocationEvidence.verified.permissionProfile.evidence = "caller_invented";
    const unknownEvidenceValidation = await validateResultCapsule(unknownEvidence, { root });
    assert.equal(unknownEvidenceValidation.valid, false);
    assert.match(unknownEvidenceValidation.errors.join(" "), /evidence|unknown/i);
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { executorAdapter: "codex-delegate", executorProviderFamily: "codex" });
    await write(root, "brief.md", "brief\n");
    const resultPathValue = resultPath("codex-executor-meaning", 1);
    const relayScript = await codexRelayFixture(root, resultPathValue, { status: "completed", exitCode: 0, sessionId: "codex-meaning-session" });
    const explicit = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-a",
      jobKey: "codex-executor-meaning",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "codex-delegate",
      args: [relayScript, "--model", "executor-model", "--effort", "high", "--sandbox", "workspace-write"],
      adapterEnvelope: adapterEnvelope({ role: "executor", providerFamily: "codex", adapterIdentifier: "codex-delegate" }),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(explicit.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(explicit));
    assert.equal(explicit.capsule.invocationEvidence.meaning, "requested_argv_only");
    const explicitValidation = await validateResultCapsule(explicit.capsule, { root });
    assert.equal(explicitValidation.valid, true, JSON.stringify(explicitValidation));

    const invalidMixed = structuredClone(explicit.capsule);
    invalidMixed.invocationEvidence.meaning = "requested_argv_and_adapter_default";
    const invalidMixedValidation = await validateResultCapsule(invalidMixed, { root });
    assert.equal(invalidMixedValidation.valid, false);
    assert.match(invalidMixedValidation.errors.join(" "), /meaning|adapter-default/i);
  });
});

test("C-20: runtime scratch hygiene and CLI exit help match implemented behavior", async () => {
  const gitignore = await fs.readFile(path.join(source, ".gitignore"), "utf8");
  const readme = await fs.readFile(path.join(source, "README.md"), "utf8");
  assert.match(gitignore, /^tests\/\.dd-runtime-scratch\/$/m);
  assert.match(readme, /ignored[\s\S]*tests\/\.dd-runtime-scratch\//);
  assert.doesNotMatch(HELP, /0 for valid output and bounded human\/planner stops/);
  assert.match(HELP, /AWAITING_SESSION_BINDING dispatch result/);

  await withFixture(async (root) => {
    await configuredRoot(root);
    const status = await execute(["status", "--root", root, "--phase-key", "phase-1", "--work-package-key", "wp-a", "--job-key", "cli-status"]);
    assert.equal(status.exitCode, 0, JSON.stringify(status));
    assert.notEqual(status.result.status, "STOPPED", JSON.stringify(status));

    await write(root, "brief.md", "brief\n");
    const stopped = await execute([
      "dispatch",
      "--root", root,
      "--role", "executor",
      "--job-key", "cli-mechanical-stop",
      "--phase-key", "phase-1",
      "--work-package-key", "wp-a",
      "--brief", "brief.md",
      "--adapter", process.execPath,
      "--args-json", "[]",
      "--create-session", "true",
      "--wait-path", "described_equivalent",
    ]);
    assert.equal(stopped.exitCode, 1, JSON.stringify(stopped));
    assert.equal(stopped.result.status, "STOPPED", JSON.stringify(stopped));
    assert.equal(stopped.result.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(stopped));
  });
});

test("C-21: an unresolved binding request gates exact replay and rejects divergent initial and replacement dispatches", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await write(root, "provider-launch-counter", "0\n");

    const initialPath = resultPath("c21-initial", 1);
    const initialArgs = ["-e", seededCounterAdapterCode(initialPath, { status: "completed", exitCode: 0, sessionId: "c21-initial-session" })];
    const initialOptions = {
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-c21",
      jobKey: "c21-initial",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: initialArgs,
      adapterEnvelope: adapterEnvelope(),
      createSession: true,
      waitPath: "described_equivalent",
    };
    const initial = await dispatchRole(initialOptions);
    assert.equal(initial.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(initial));
    assert.equal(await fs.readFile(path.join(root, "provider-launch-counter"), "utf8"), "1");

    const initialReplay = await dispatchRole(initialOptions);
    assert.equal(initialReplay.status, "REUSED", JSON.stringify(initialReplay));
    assert.equal(initialReplay.runtimeStatus, "AWAITING_SESSION_BINDING");
    assert.equal(initialReplay.bindingRequestPath, initial.bindingRequestPath);
    assert.equal(initialReplay.bindingRequestDigest, initial.bindingRequestDigest);
    assert.equal(initialReplay.resultPath, initialPath);
    assert.equal(await fs.readFile(path.join(root, "provider-launch-counter"), "utf8"), "1");

    const divergentInitial = await dispatchRole({
      ...initialOptions,
      args: ["-e", seededCounterAdapterCode(initialPath, { status: "completed", exitCode: 0, sessionId: "c21-divergent-initial" })],
    });
    assert.equal(divergentInitial.stopCode, "STOPPED_BINDING_PENDING_CONTRADICTION", JSON.stringify(divergentInitial));
    assert.equal(divergentInitial.dispatchCount ?? 0, 0);
    assert.equal(await fs.readFile(path.join(root, "provider-launch-counter"), "utf8"), "1");

    const scope = "work-package:phase-1/wp-c21";
    const initialBinding = await confirmSessionBinding({ root, role: "executor", scope, sessionId: "c21-initial-session", sourceResultPath: initialPath, confirmedBy: "planning-lead" });
    const authorizationPath = "c21-replacement-authority.txt";
    await write(root, authorizationPath, "c21 replacement authority\n");
    const authorizationDigest = sha256Bytes("c21 replacement authority\n");
    const replacementPath = resultPath("c21-initial", 2);
    const replacementOptions = {
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-c21",
      jobKey: "c21-initial",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", seededCounterAdapterCode(replacementPath, { status: "completed", exitCode: 0, sessionId: "c21-replacement-session" })],
      adapterEnvelope: adapterEnvelope(),
      replaceSession: true,
      replacementMode: "create",
      createSession: true,
      replacementAuthorizationPath: authorizationPath,
      replacementAuthorizationDigest: authorizationDigest,
      currentBindingPath: initialBinding.path,
      currentBindingDigest: initialBinding.digest,
      attempt: 2,
      attemptKind: "correction",
      correctionOrdinal: 1,
      attemptAuthorizationPath: authorizationPath,
      attemptAuthorizationDigest: authorizationDigest,
      waitPath: "described_equivalent",
    };
    const replacement = await dispatchRole(replacementOptions);
    assert.equal(replacement.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(replacement));
    assert.equal(await fs.readFile(path.join(root, "provider-launch-counter"), "utf8"), "2");

    const replacementReplay = await dispatchRole(replacementOptions);
    assert.equal(replacementReplay.status, "REUSED", JSON.stringify(replacementReplay));
    assert.equal(replacementReplay.runtimeStatus, "AWAITING_SESSION_BINDING");
    assert.equal(replacementReplay.bindingRequestPath, replacement.bindingRequestPath);
    assert.equal(await fs.readFile(path.join(root, "provider-launch-counter"), "utf8"), "2");

    const divergentReplacement = await dispatchRole({
      ...replacementOptions,
      args: ["-e", seededCounterAdapterCode(replacementPath, { status: "completed", exitCode: 0, sessionId: "c21-divergent-replacement" })],
    });
    assert.equal(divergentReplacement.stopCode, "STOPPED_BINDING_PENDING_CONTRADICTION", JSON.stringify(divergentReplacement));
    assert.equal(divergentReplacement.dispatchCount ?? 0, 0);
    assert.equal(await fs.readFile(path.join(root, "provider-launch-counter"), "utf8"), "2");
  });
});

test("C-22: capability transport is tri-state and unknown mapped profiles stop before the seeded provider counter can advance", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root, { plannerAdapter: "claude-delegate", plannerProviderFamily: "claude", plannerPermissionProfile: "unknown-profile" });
    await write(root, "brief.md", "brief\n");
    await write(root, "provider-launch-counter", "0\n");
    const resultPathValue = resultPath("c22-unknown-claude", 1);
    const stopped = await dispatchRole({
      root,
      role: "planner-2",
      phaseKey: "phase-1",
      workPackageKey: "wp-c22",
      jobKey: "c22-unknown-claude",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "claude-delegate",
      args: ["-e", seededCounterAdapterCode(resultPathValue, { status: "completed", exitCode: 0, sessionId: "never" }), "--model", "planner-model", "--effort", "high", "--read-only", "--autocompact", "400k"],
      adapterEnvelope: adapterEnvelope({ role: "planner-2", providerFamily: "claude", adapterIdentifier: "claude-delegate" }),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(stopped.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(stopped));
    assert.match(stopped.reason, /unsupported|capability|mapped/i);
    assert.equal((await fs.readFile(path.join(root, "provider-launch-counter"), "utf8")).trim(), "0");
    await assert.rejects(fs.stat(path.join(root, resultPathValue)));
  });

  await withFixture(async (root) => {
    await configuredRoot(root, { executorAdapter: "codex-delegate", executorProviderFamily: "codex", executorPermissionProfile: "unknown-profile" });
    await write(root, "brief.md", "brief\n");
    await write(root, "provider-launch-counter", "0\n");
    const resultPathValue = resultPath("c22-unknown-codex", 1);
    const stopped = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-c22",
      jobKey: "c22-unknown-codex",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "codex-delegate",
      args: ["-e", seededCounterAdapterCode(resultPathValue, { status: "completed", exitCode: 0, sessionId: "never" }), "--model", "executor-model", "--effort", "high", "--sandbox", "workspace-write"],
      adapterEnvelope: adapterEnvelope({ role: "executor", providerFamily: "codex", adapterIdentifier: "codex-delegate" }),
      createSession: true,
      waitPath: "described_equivalent",
    });
    assert.equal(stopped.stopCode, "STOPPED_INVALID_ENVELOPE", JSON.stringify(stopped));
    assert.match(stopped.reason, /unsupported|capability|mapped/i);
    assert.equal((await fs.readFile(path.join(root, "provider-launch-counter"), "utf8")).trim(), "0");
    await assert.rejects(fs.stat(path.join(root, resultPathValue)));
  });

  const codexPlanner = validateInvocationContract({
    contract: invocationContract({ role: "planner-2", providerFamily: "codex", adapterIdentifier: "codex-delegate" }),
    args: ["--model", "planner-model", "--effort", "high", "--read-only"],
    adapterIdentifier: "codex-delegate",
    publicRole: "planner-2",
    roleProfile: { providerFamily: "codex", modelLabel: "planner-model", effort: "high", permissionProfile: "read-only" },
  });
  assert.equal(codexPlanner.verified.permissionProfile.outcome, "verified_requested");

  const codexExecutor = validateInvocationContract({
    contract: invocationContract({ role: "executor", providerFamily: "codex", adapterIdentifier: "codex-delegate" }),
    args: ["--model", "executor-model", "--effort", "high", "--sandbox", "workspace-write"],
    adapterIdentifier: "codex-delegate",
    publicRole: "executor",
    roleProfile: { providerFamily: "codex", modelLabel: "executor-model", effort: "high", permissionProfile: "workspace-write", noCommit: "instruction_only" },
  });
  assert.equal(codexExecutor.verified.permissionProfile.outcome, "verified_requested");

  const claudeDefault = validateInvocationContract({
    contract: invocationContract({ role: "executor", providerFamily: "claude", adapterIdentifier: "claude-delegate" }),
    args: ["--model", "executor-model", "--effort", "high"],
    adapterIdentifier: "claude-delegate",
    publicRole: "executor",
    roleProfile: { providerFamily: "claude", modelLabel: "executor-model", effort: "high", permissionProfile: "workspace-write", noCommit: "instruction_only" },
  });
  assert.equal(claudeDefault.verified.permissionProfile.evidence, "adapter_default");

  const fixtureNotTransported = validateInvocationContract({
    contract: invocationContract(),
    args: ["-e", "fixture"],
    adapterIdentifier: "local-fixture",
    publicRole: "executor",
    roleProfile: { providerFamily: "other", modelLabel: "executor-model", effort: "high", permissionProfile: "workspace-write", noCommit: "instruction_only" },
  });
  assert.equal(fixtureNotTransported.verified.permissionProfile.outcome, "not_applicable");
});

test("C-23: one canonical injective scope helper is shared by dispatch, records, confirmation, inspection, and status", async () => {
  const collisionLeft = deriveSessionScope("executor", { sessionScope: "work_package_scoped" }, { phaseKey: "a/b", workPackageKey: "c" });
  const collisionRight = deriveSessionScope("executor", { sessionScope: "work_package_scoped" }, { phaseKey: "a", workPackageKey: "b/c" });
  assert.notEqual(collisionLeft, collisionRight);
  assert.equal(canonicalSessionScope("executor", collisionLeft), collisionLeft);
  assert.equal(canonicalSessionScope("executor", collisionRight), collisionRight);

  const unicodePhase = "مرحلة / % space";
  const unicodeWorkPackage = "工作 / % space";
  const unicodeScope = deriveSessionScope("executor", { sessionScope: "work_package_scoped" }, { phaseKey: unicodePhase, workPackageKey: unicodeWorkPackage });
  assert.match(unicodeScope, /%2F|%25|%20/i);
  assert.equal(canonicalSessionScope("executor", unicodeScope), unicodeScope);

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const leftPath = resultPath("c23-left", 1);
    const rightPath = resultPath("c23-right", 1);
    const left = await dispatchRole({ root, role: "executor", phaseKey: "a/b", workPackageKey: "c", jobKey: "c23-left", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(leftPath, { status: "completed", exitCode: 0, sessionId: "c23-left-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    const right = await dispatchRole({ root, role: "executor", phaseKey: "a", workPackageKey: "b/c", jobKey: "c23-right", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(rightPath, { status: "completed", exitCode: 0, sessionId: "c23-right-session" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(left.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(left));
    assert.equal(right.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(right));
    assert.notEqual(left.bindingRequestPath, right.bindingRequestPath);
    const pendingStatus = await runtimeStatus({ root, phaseKey: "a/b", workPackageKey: "c" });
    assert.equal(pendingStatus.status, "AWAITING_SESSION_BINDING", JSON.stringify(pendingStatus));
    await confirmSessionBinding({ root, role: "executor", scope: collisionLeft, sessionId: "c23-left-session", sourceResultPath: leftPath, confirmedBy: "planning-lead" });
    await confirmSessionBinding({ root, role: "executor", scope: collisionRight, sessionId: "c23-right-session", sourceResultPath: rightPath, confirmedBy: "planning-lead" });
    const inspected = await inspectSessionBindings({ root, role: "executor" });
    const scopes = inspected.flatMap((entry) => entry.scopes.map((item) => item.scope));
    assert.equal(scopes.includes(collisionLeft), true);
    assert.equal(scopes.includes(collisionRight), true);
  });
});

test("C-24: confirmed host wait capability is an upper bound for both roles and unavailable cannot be overridden", async () => {
  for (const role of ["planner-2", "executor"]) {
    await withFixture(async (root) => {
      await configuredRoot(root, { hostWaitCapability: "unavailable" });
      await write(root, "brief.md", "brief\n");
      await write(root, "provider-launch-counter", "0\n");
      const resultPathValue = resultPath(`c24-unavailable-${role}`, 1);
      const stopped = await dispatchRole({
        root,
        role,
        phaseKey: "phase-1",
        workPackageKey: "wp-c24",
        jobKey: `c24-unavailable-${role}`,
        briefPath: "brief.md",
        adapter: process.execPath,
        adapterIdentifier: "local-fixture",
        args: ["-e", seededCounterAdapterCode(resultPathValue, { status: "completed", exitCode: 0, sessionId: "never" })],
        adapterEnvelope: adapterEnvelope({ role }),
        createSession: true,
        waitPath: "described_equivalent",
        suspensionAvailable: true,
      });
      assert.equal(stopped.stopCode, "STOPPED_WAIT_PATH", JSON.stringify(stopped));
      assert.equal((await fs.readFile(path.join(root, "provider-launch-counter"), "utf8")).trim(), "0");
      await assert.rejects(fs.stat(path.join(root, resultPathValue)));
    });
  }

  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    await write(root, "provider-launch-counter", "0\n");
    const resultPathValue = resultPath("c24-mismatch", 1);
    const stopped = await dispatchRole({
      root,
      role: "executor",
      phaseKey: "phase-1",
      workPackageKey: "wp-c24",
      jobKey: "c24-mismatch",
      briefPath: "brief.md",
      adapter: process.execPath,
      adapterIdentifier: "local-fixture",
      args: ["-e", seededCounterAdapterCode(resultPathValue, { status: "completed", exitCode: 0, sessionId: "never" })],
      adapterEnvelope: adapterEnvelope(),
      createSession: true,
      waitPath: "single_outer_call",
      suspensionAvailable: true,
    });
    assert.equal(stopped.stopCode, "STOPPED_WAIT_PATH", JSON.stringify(stopped));
    assert.equal((await fs.readFile(path.join(root, "provider-launch-counter"), "utf8")).trim(), "0");
  });
});

test("C-25: confirmSessionBinding reuses identical initial and replacement confirmations without duplicate bindings or events", async () => {
  await withFixture(async (root) => {
    await configuredRoot(root);
    await write(root, "brief.md", "brief\n");
    const initialPath = resultPath("c25-initial", 1);
    const initial = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-c25", jobKey: "c25-initial", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(initialPath, { status: "completed", exitCode: 0, sessionId: "c25-old" })], adapterEnvelope: adapterEnvelope(), createSession: true, waitPath: "described_equivalent" });
    assert.equal(initial.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(initial));
    const scope = "work-package:phase-1/wp-c25";
    const firstBinding = await confirmSessionBinding({ root, role: "executor", scope, sessionId: "c25-old", sourceResultPath: initialPath, confirmedBy: "planning-lead" });
    const eventRoot = path.join(root, DEFAULT_RECORDS_ROOT, "runtime", "events");
    const sessionBoundCount = async () => {
      const files = await fs.readdir(eventRoot);
      let count = 0;
      for (const file of files) {
        const event = JSON.parse(await fs.readFile(path.join(eventRoot, file), "utf8"));
        if (event.eventType === "session_bound") count += 1;
      }
      return count;
    };
    const initialEventCount = await sessionBoundCount();
    const initialReplay = await confirmSessionBinding({ root, role: "executor", scope, sessionId: "c25-old", sourceResultPath: initialPath, confirmedBy: "planning-lead" });
    assert.equal(initialReplay.status, "REUSED", JSON.stringify(initialReplay));
    assert.equal(initialReplay.path, firstBinding.path);
    assert.equal(await sessionBoundCount(), initialEventCount);
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope, sessionId: "c25-old", sourceResultPath: initialPath, confirmedBy: "different-confirmation" }), /contradict/);
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope, sessionId: "c25-other-session", sourceResultPath: initialPath, confirmedBy: "planning-lead" }), /contradict/);
    await write(root, "c25-unrelated-result.json", JSON.stringify({ status: "completed", exitCode: 0, sessionId: "c25-old" }));
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope, sessionId: "c25-old", sourceResultPath: "c25-unrelated-result.json", confirmedBy: "planning-lead" }), /contradict/);
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope, sessionId: "c25-old", sourceResultPath: initialPath, sourceResultDigest: "0".repeat(64), confirmedBy: "planning-lead" }), /supplied evidence/);
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope: "work-package:phase-1/other", sessionId: "c25-old", sourceResultPath: initialPath, confirmedBy: "planning-lead" }), /pending|contradict/);

    const authorizationPath = "c25-replacement-authority.txt";
    await write(root, authorizationPath, "c25 replacement authority\n");
    const authorizationDigest = sha256Bytes("c25 replacement authority\n");
    const replacementPath = resultPath("c25-initial", 2);
    const replacement = await dispatchRole({ root, role: "executor", phaseKey: "phase-1", workPackageKey: "wp-c25", jobKey: "c25-initial", briefPath: "brief.md", adapter: process.execPath, adapterIdentifier: "local-fixture", args: ["-e", adapterCode(replacementPath, { status: "completed", exitCode: 0, sessionId: "c25-new" })], adapterEnvelope: adapterEnvelope(), replaceSession: true, replacementMode: "create", createSession: true, replacementAuthorizationPath: authorizationPath, replacementAuthorizationDigest: authorizationDigest, currentBindingPath: firstBinding.path, currentBindingDigest: firstBinding.digest, attempt: 2, attemptKind: "correction", correctionOrdinal: 1, attemptAuthorizationPath: authorizationPath, attemptAuthorizationDigest: authorizationDigest, waitPath: "described_equivalent" });
    assert.equal(replacement.runtimeStatus, "AWAITING_SESSION_BINDING", JSON.stringify(replacement));
    const replacementBinding = await confirmSessionBinding({ root, role: "executor", scope, replaceSession: true, replacementAuthorizationPath: authorizationPath, replacementAuthorizationDigest: authorizationDigest, sessionId: "c25-new", sourceResultPath: replacementPath, confirmedBy: "planning-lead" });
    const replacementEventCount = await sessionBoundCount();
    const replacementReplay = await confirmSessionBinding({ root, role: "executor", scope, replaceSession: true, replacementAuthorizationPath: authorizationPath, replacementAuthorizationDigest: authorizationDigest, sessionId: "c25-new", sourceResultPath: replacementPath, confirmedBy: "planning-lead" });
    assert.equal(replacementReplay.status, "REUSED", JSON.stringify(replacementReplay));
    assert.equal(replacementReplay.path, replacementBinding.path);
    assert.equal(await sessionBoundCount(), replacementEventCount);
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope, replaceSession: true, replacementVersion: 99, replacementAuthorizationPath: authorizationPath, replacementAuthorizationDigest: authorizationDigest, sessionId: "c25-new", sourceResultPath: replacementPath, confirmedBy: "planning-lead" }), /contradict/);
    const changedAuthorizationPath = "c25-changed-authority.txt";
    await write(root, changedAuthorizationPath, "changed c25 replacement authority\n");
    const changedAuthorizationDigest = sha256Bytes("changed c25 replacement authority\n");
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope, replaceSession: true, replacementAuthorizationPath: changedAuthorizationPath, replacementAuthorizationDigest: changedAuthorizationDigest, sessionId: "c25-new", sourceResultPath: replacementPath, confirmedBy: "planning-lead" }), /contradict/);
    await assert.rejects(confirmSessionBinding({ root, role: "executor", scope, replaceSession: true, replacementAuthorizationPath: authorizationPath, replacementAuthorizationDigest: authorizationDigest, sessionId: "c25-other-session", sourceResultPath: replacementPath, confirmedBy: "planning-lead" }), /contradict/);
    const inspected = await inspectSessionBindings({ root, role: "executor" });
    const scopeEntry = inspected.flatMap((entry) => entry.scopes).find((item) => item.scope === scope);
    assert.equal(scopeEntry.bindings.length, 2, JSON.stringify(scopeEntry));
  });
});
