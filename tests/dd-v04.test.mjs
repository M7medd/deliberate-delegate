import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProcessJobController, resolveSuspensionStatus } from "../skills/deliberate-delegate/scripts/lib/job-controller.mjs";
import {
  CAPSULE_SCHEMA,
  createResultCapsule,
  emitResultCapsule,
  loadAndValidateCapsule,
  roleStatuses,
  validateResultCapsule,
} from "../skills/deliberate-delegate/scripts/lib/result-capsule.mjs";
import {
  ABSOLUTE_CORRECTION_CEILING,
  createCorrectionPolicy,
  evaluateCorrection,
} from "../skills/deliberate-delegate/scripts/lib/lifecycle-core.mjs";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(source, "tests", ".dd-v04-scratch");

async function fixture() {
  await fs.mkdir(scratch, { recursive: true });
  return fs.mkdtemp(path.join(scratch, "fixture-"));
}

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.replaceAll("\\", "/").split("/"));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

async function withFixture(fn) {
  const root = await fixture();
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function adapterProgram(value, { delayMs = 150, exit = 0, count = true, resultPath = "result.json" } = {}) {
  const countCode = count ? "require('fs').appendFileSync('dispatch-count','1');" : "";
  return `const fs=require('fs');${countCode}fs.writeFileSync(${JSON.stringify(resultPath)},${JSON.stringify(JSON.stringify(value))});setTimeout(()=>process.exit(${exit}),${delayMs});`;
}

function rawCapsuleOptions(root, extra = {}) {
  return {
    root,
    dispatchId: "dispatch-1",
    idempotencyKey: "idem-1",
    role: "executor",
    roleStatus: "READY_FOR_VERIFICATION",
    adapter: "test-adapter",
    process: { terminalStatus: "completed", exitCode: 0, processTreeTermination: "child-only" },
    result: { terminalStatus: "completed", exitCode: 0 },
    requestedSessionId: "session-1",
    observedSessionIds: ["session-1"],
    sessionVerification: "matched",
    suspensionStatus: "unknown",
    rawArtifacts: ["evidence.txt"],
    changedPaths: ["src/a.txt"],
    gateCoverage: { checks: ["unit tests"] },
    ...extra,
  };
}

test("AC-4/AC-6/AC-9: ProcessJobController dispatches once, observes result-before-exit, and reuses a terminal capsule", async () => {
  await withFixture(async (root) => {
    const controller = new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "session-1" })],
      result: "result.json",
      artifactDir: "raw/job-01",
      expectedSession: "session-1",
      suspensionAvailable: true,
      timeoutMs: 5000,
    });
    const first = await controller.dispatch();
    const second = await controller.dispatch();
    assert.equal(first.status, "PASS");
    assert.equal(second.dispatchCount, 1);
    assert.equal(first.dispatchCount, 1);
    assert.equal(first.capsule.schemaVersion, CAPSULE_SCHEMA);
    assert.equal(first.capsule.suspensionStatus, "unknown");
    assert.equal(first.capsule.sessionVerification, "matched");
    assert.equal(first.resultObservedBeforeProcessExit, true);
    assert.match(first.idempotencyKey, /^dd:[a-f0-9]{64}$/);
    assert.equal(first.dispatchIdentityHash.length, 64);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");

    const restarted = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "session-1" })],
      result: "result.json",
      artifactDir: "raw/job-01",
      expectedSession: "session-1",
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(restarted.status, "REUSED");
    assert.equal(restarted.dispatchCount, 0);
    assert.equal(restarted.idempotencyKey, first.idempotencyKey);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");

    const callerKeyMismatch = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "session-1" })],
      result: "result.json",
      artifactDir: "raw/job-01",
      expectedSession: "session-1",
      idempotencyKey: "caller-supplied-different",
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(callerKeyMismatch.status, "FAIL");
    assert.equal(callerKeyMismatch.dispatchCount, 0);
    assert.match(callerKeyMismatch.reason, /idempotency key/);

    const changedArgv = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "session-1" }), "changed-argv"],
      result: "result.json",
      artifactDir: "raw/job-01",
      expectedSession: "session-1",
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(changedArgv.status, "FAIL");
    assert.equal(changedArgv.dispatchCount, 0);
    assert.match(changedArgv.reason, /idempotency key|dispatch identity/);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });
});

test("AC-5: unavailable suspension is recorded and stops without a polling fallback", async () => {
  await withFixture(async (root) => {
    const result = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0 })],
      result: "result.json",
      artifactDir: "raw/unavailable",
      suspensionAvailable: false,
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.suspensionStatus, "unavailable");
    assert.equal(result.dispatchCount, 0);
    assert.equal(await fs.stat(path.join(root, result.stopPath)).then(() => true), true);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });
  assert.deepEqual(resolveSuspensionStatus({ available: false }).shouldStop, true);
});

test("AC-6/AC-8: capsules are bounded, role-scoped, digest-checked, and honest about suspension evidence", async () => {
  await withFixture(async (root) => {
    await write(root, "evidence.txt", "raw evidence\n");
    await write(root, "changed-paths.json", "[\"full path evidence\"]\n");
    await write(root, "gates.json", "[\"full gate evidence\"]\n");
    const emitted = await emitResultCapsule(root, "raw/capsule.json", rawCapsuleOptions(root, {
      changedPaths: { items: Array.from({ length: 100 }, (_, index) => `src/${index}.txt`), rawLocator: "changed-paths.json" },
      gateCoverage: { checks: Array.from({ length: 100 }, (_, index) => `gate-${index}`), rawLocator: "gates.json" },
      maxBytes: 8192,
    }));
    assert.equal(emitted.capsule.schemaVersion, CAPSULE_SCHEMA);
    assert.equal(emitted.capsule.truncation.changedPaths, true);
    assert.ok(emitted.capsule.changedPaths.rawLocator);
    assert.equal(emitted.capsule.rawArtifacts[0].sha256.length, 64);
    assert.equal(emitted.capsule.gateCoverage.complete, false);
    assert.equal(emitted.capsule.gateCoverage.status, "unknown");
    assert.equal((await loadAndValidateCapsule(root, "raw/capsule.json", { expectedSession: "session-1" })).valid, true);

    const oversized = await emitResultCapsule(root, "raw/capsule-oversized.json", rawCapsuleOptions(root, {
      changedPaths: { items: Array.from({ length: 100 }, (_, index) => `src/${index}-${"x".repeat(100)}`), rawLocator: "changed-paths.json" },
      gateCoverage: { checks: Array.from({ length: 100 }, (_, index) => `gate-${index}-${"x".repeat(100)}`), rawLocator: "gates.json" },
      providerUsage: { inputTokens: "x".repeat(100000), nested: { outputTokens: "y".repeat(100000) } },
      maxBytes: 8192,
    }));
    assert.ok(Buffer.byteLength(oversized.text, "utf8") <= 8192);
    assert.equal(oversized.capsule.providerUsage, undefined);
    assert.equal(oversized.capsule.truncation.providerUsage, true);
    assert.ok(oversized.capsule.omittedItemCounts.providerUsage >= 1);
    assert.equal(oversized.capsule.truncation.changedPaths, true);
    assert.equal(oversized.capsule.truncation.gateCoverage, true);
    assert.ok(oversized.capsule.changedPaths.items.length <= 8);
    assert.ok(oversized.capsule.gateCoverage.checks.items.length <= 8);

    const missingCoverage = await createResultCapsule(rawCapsuleOptions(root, { gateCoverage: {} }));
    assert.equal(missingCoverage.capsule.gateCoverage.complete, false);
    assert.equal(missingCoverage.capsule.gateCoverage.status, "unknown");
    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, { gateCoverage: { checks: [], complete: true } })), /complete cannot be true/);
    const invalidComplete = {
      ...emitted.capsule,
      gateCoverage: { ...emitted.capsule.gateCoverage, checks: { items: [], omittedCount: 0 }, complete: true },
    };
    assert.equal((await validateResultCapsule(invalidComplete, { root })).valid, false);

    const tampered = JSON.parse(await fs.readFile(path.join(root, "raw/capsule.json"), "utf8"));
    tampered.rawArtifacts[0].sha256 = "0".repeat(64);
    assert.equal((await validateResultCapsule(tampered, { root })).valid, false);
    delete tampered.rawArtifacts[0].sha256;
    assert.equal((await validateResultCapsule(tampered, { root })).valid, false);

    const nonterminal = { ...emitted.capsule, processStatus: "running", process: { ...emitted.capsule.process, terminalStatus: "running" } };
    assert.equal((await validateResultCapsule(nonterminal, { root })).valid, false);
    assert.equal((await validateResultCapsule(emitted.capsule, { root, expectedSession: "wrong" })).valid, false);
    assert.equal((await validateResultCapsule(emitted.capsule, { root, notBefore: "2999-01-01T00:00:00.000Z" })).valid, false);

    const nullMatched = { ...emitted.capsule, requestedSessionId: null, observedSessionIds: [], sessionVerification: "matched" };
    const requestedEmptyMatched = { ...emitted.capsule, requestedSessionId: "requested", observedSessionIds: [], sessionVerification: "matched" };
    const requestedNonmatchingMatched = { ...emitted.capsule, requestedSessionId: "requested", observedSessionIds: ["other"], sessionVerification: "matched" };
    assert.equal((await validateResultCapsule(nullMatched, { root })).valid, false);
    assert.equal((await validateResultCapsule(requestedEmptyMatched, { root })).valid, false);
    assert.equal((await validateResultCapsule(requestedNonmatchingMatched, { root })).valid, false);

    const enforced = await createResultCapsule(rawCapsuleOptions(root, {
      dispatchId: "dispatch-enforced",
      idempotencyKey: "idem-enforced",
      suspensionStatus: "enforced",
      hostTelemetry: { leadModelTurnsBetweenDispatchAndTerminal: 0 },
      suspensionEvidence: { basis: "host telemetry", hostTelemetry: { leadModelTurnsBetweenDispatchAndTerminal: 0 } },
    }));
    assert.equal(enforced.capsule.suspensionStatus, "enforced");
    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, {
      dispatchId: "dispatch-invalid-suspension",
      idempotencyKey: "idem-invalid-suspension",
      suspensionStatus: "enforced",
    })), /zero Lead model turns/);
  });
  assert.deepEqual(roleStatuses("executor"), ["READY_FOR_VERIFICATION", "FAILED"]);
  assert.deepEqual(roleStatuses("planner"), ["APPROVE", "BLOCK", "NEEDS_EVIDENCE"]);
  assert.deepEqual(roleStatuses("mechanical"), ["PASS", "FAIL", "UNKNOWN"]);
});

test("AC-9/AC-10: uncertain restart, session mismatch, and timeout fail closed with explicit process coverage", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "raw/uncertain"), { recursive: true });
    await write(root, "raw/uncertain/job.v1.json", JSON.stringify({ schemaVersion: "dd.process-job.v1", dispatchId: "old", idempotencyKey: "old-key", state: "DISPATCHING" }));
    const uncertain = await new ProcessJobController({ root, adapter: process.execPath, args: ["-e", adapterProgram({ status: "completed", exitCode: 0 }, { count: false })], result: "result.json", artifactDir: "raw/uncertain", idempotencyKey: "old-key", timeoutMs: 5000 }).dispatch();
    assert.equal(uncertain.status, "UNKNOWN");
    assert.equal(uncertain.dispatchCount, 0);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));

    const mismatch = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "other" }, { resultPath: "mismatch.json" })],
      result: "mismatch.json",
      artifactDir: "raw/mismatch",
      expectedSession: "expected",
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(mismatch.status, "FAIL");
    assert.equal(mismatch.sessionVerification, "mismatch");
    assert.match(mismatch.failureReasons.join(" "), /expected session/);
    assert.match(mismatch.capsule.process.processTreeTermination, /child-only/);

    const timeout = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      result: "timeout.json",
      artifactDir: "raw/timeout",
      timeoutMs: 100,
    }).dispatch();
    assert.equal(timeout.status, "FAIL");
    assert.equal(timeout.process.timedOut, true);
    assert.match(timeout.capsule.process.processTreeTermination, /child-only/);
  });
});

test("AC-11: correction policy is Phase-configured, bounded, and stops on no progress", () => {
  const defaults = createCorrectionPolicy();
  assert.equal(defaults.maxCorrections, 2);
  assert.equal(defaults.absoluteCeiling, ABSOLUTE_CORRECTION_CEILING);
  assert.equal(createCorrectionPolicy({ maxCorrections: 1 }).maxCorrections, 1);
  assert.throws(() => createCorrectionPolicy({ maxCorrections: ABSOLUTE_CORRECTION_CEILING + 1 }), /maxCorrections/);
  assert.throws(() => createCorrectionPolicy({ maxCorrections: 3, source: "executor" }), /executor/);
  assert.equal(evaluateCorrection({ policy: defaults, attempt: 1, priorDefects: ["D-1"], currentDefects: ["D-1"] }).decision, "STOP");
  assert.equal(evaluateCorrection({ policy: defaults, attempt: 1, priorDefects: ["D-1"], currentDefects: ["D-1"], meaningfulDelta: true }).decision, "ALLOW");
  assert.equal(evaluateCorrection({ policy: defaults, attempt: 2, priorDefects: ["D-1"], currentDefects: ["D-2"], meaningfulDelta: true }).stopCode, "STOPPED_CORRECTION_LIMIT");
  assert.equal(evaluateCorrection({ policy: defaults, attempt: 2, priorDefects: [], currentDefects: [] }).decision, "ACCEPT");
});
