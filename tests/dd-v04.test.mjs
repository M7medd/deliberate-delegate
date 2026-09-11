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
const adapterEnvelope = {
  schemaVersion: "dd.adapter-envelope.v1",
  effectiveWorkingDirectory: ".",
  cwdMode: "inherits_process",
  adapterContract: null,
};
const adapterContractEnvelope = {
  schemaVersion: "dd.adapter-envelope.v1",
  effectiveWorkingDirectory: ".",
  cwdMode: "adapter_contract",
  adapterContract: {
    adapter: process.execPath,
    cwdArgument: "--cd",
    cwdValue: ".",
  },
};

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

async function assertInvalidEnvelopeStop(root, name, envelope, args = ["-e", adapterProgram({ status: "completed", exitCode: 0 })]) {
  const resultPath = `${name}.json`;
  const artifactDir = `raw/${name}`;
  const result = await new ProcessJobController({
    root,
    adapterEnvelope: envelope,
    adapter: process.execPath,
    args,
    result: resultPath,
    artifactDir,
    suspensionAvailable: true,
    timeoutMs: 5000,
  }).dispatch();
  assert.equal(result.status, "STOPPED_INVALID_ENVELOPE", name);
  assert.equal(result.dispatchCount, 0, name);
  assert.equal(result.dispatchIdentityHash, null, name);
  const job = JSON.parse(await fs.readFile(path.join(root, artifactDir, "job.v1.json"), "utf8"));
  const stop = JSON.parse(await fs.readFile(path.join(root, artifactDir, "adapter-envelope-stop.v1.json"), "utf8"));
  assert.equal(job.state, "STOPPED_INVALID_ENVELOPE", name);
  assert.equal(stop.status, "STOPPED_INVALID_ENVELOPE", name);
  assert.equal(stop.providerLaunched, false, name);
  assert.equal(stop.dispatchCount, 0, name);
  assert.equal(stop.capsulePath, null, name);
  await assert.rejects(fs.stat(path.join(root, resultPath)), undefined, name);
  await assert.rejects(fs.stat(path.join(root, artifactDir, "capsule.v1.json")), undefined, name);
  await assert.rejects(fs.stat(path.join(root, "dispatch-count")), undefined, name);
  return { job, stop };
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
      adapterEnvelope,
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
    const persistedJob = JSON.parse(await fs.readFile(path.join(root, "raw/job-01/job.v1.json"), "utf8"));
    assert.equal(persistedJob.adapterEnvelope.effectiveWorkingDirectory, ".");
    assert.equal(persistedJob.adapterEnvelopeDigest, persistedJob.adapterEnvelope.normalizedDigest);
    assert.equal(persistedJob.adapterEnvelope.sourceFileDigest, null);
    assert.equal(first.capsule.adapterEnvelopeDigest, persistedJob.adapterEnvelope.normalizedDigest);
    assert.equal(first.capsule.adapterEnvelope.sourceFileDigest, null);
    assert.match(first.capsule.adapterEnvelope.limitation, /not OS attestation/);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");

    const restarted = await new ProcessJobController({
      root,
      adapterEnvelope,
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
      adapterEnvelope,
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
      adapterEnvelope,
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
      adapterEnvelope,
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
  assert.equal(resolveSuspensionStatus({ available: true, hostTelemetry: { leadModelTurnsBetweenDispatchAndTerminal: 0 } }).suspensionStatus, "unknown");
});

test("AC-2/AC-3/AC-4: planner verdicts stay separate from transport failure", async () => {
  await withFixture(async (root) => {
    await write(root, "evidence.txt", "raw evidence\n");
    const failedOptions = rawCapsuleOptions(root, {
      role: "planner",
      process: { terminalStatus: "failed", exitCode: 9, processTreeTermination: "child-only" },
      roleStatus: "APPROVE",
    });
    await assert.rejects(createResultCapsule(failedOptions), /TRANSPORT_FAILED/);

    const failed = await createResultCapsule(rawCapsuleOptions(root, {
      role: "planner",
      process: { terminalStatus: "failed", exitCode: 9, processTreeTermination: "child-only" },
      roleStatus: undefined,
    }));
    assert.equal(failed.capsule.roleStatus, "TRANSPORT_FAILED");
    assert.equal(failed.capsule.transportStatus, "FAILED");

    const successfulWithoutVerdict = await createResultCapsule(rawCapsuleOptions(root, {
      role: "planner",
      roleStatus: undefined,
    }));
    assert.equal(successfulWithoutVerdict.capsule.roleStatus, "NEEDS_EVIDENCE");
    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, {
      role: "planner",
      roleStatus: "TRANSPORT_FAILED",
    })), /mechanically successful/);
    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, {
      role: "planner",
      roleStatus: "APPROVE",
      process: { terminalStatus: "completed", exitCode: 0, logDrainTimedOut: true, processTreeTermination: "child-only" },
    })), /TRANSPORT_FAILED/);

    const controller = await new ProcessJobController({
      root,
      adapterEnvelope,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "session-1" }, { exit: 7 })],
      result: "failed-planner.json",
      artifactDir: "raw/failed-planner",
      role: "planner",
      roleStatus: "APPROVE",
      expectedSession: "session-1",
      suspensionAvailable: true,
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(controller.status, "FAIL");
    assert.equal(controller.capsule.roleStatus, "TRANSPORT_FAILED");
  });
});

test("AC-3: planner controller maps missing, malformed, nonterminal, and spawn failures to transport failure", async () => {
  const cases = [
    ["missing", ["-e", "process.exit(0)"], process.execPath],
    ["malformed", ["-e", adapterProgram("{broken", { resultPath: "malformed.json" })], process.execPath],
    ["nonterminal", ["-e", adapterProgram({ status: "running", exitCode: 0 }, { resultPath: "nonterminal.json" })], process.execPath],
    ["spawn", [], path.join(source, "tests", "missing-adapter-for-transport-test")],
  ];
  for (const [name, args, adapter] of cases) {
    await withFixture(async (root) => {
      const result = await new ProcessJobController({
        root,
        adapterEnvelope,
        adapter,
        args,
        result: `${name}.json`,
        artifactDir: `raw/${name}`,
        role: "planner",
        roleStatus: "APPROVE",
        suspensionAvailable: true,
        timeoutMs: 5000,
      }).dispatch();
      assert.equal(result.status, "FAIL", name);
      assert.equal(result.capsule.roleStatus, "TRANSPORT_FAILED", name);
      assert.equal(result.capsule.transportStatus, "FAILED", name);
    });
  }
});

test("AC-5/AC-6: changed-path evidence preserves omitted, complete, and incomplete states", async () => {
  await withFixture(async (root) => {
    await write(root, "evidence.txt", "raw evidence\n");
    const omitted = await createResultCapsule(rawCapsuleOptions(root, { changedPaths: undefined }));
    assert.equal(omitted.capsule.changedPaths.status, "unknown");
    assert.equal(omitted.capsule.changedPaths.complete, null);

    const empty = await createResultCapsule(rawCapsuleOptions(root, { changedPaths: { items: [], complete: true } }));
    assert.equal(empty.capsule.changedPaths.status, "complete");
    assert.equal(empty.capsule.changedPaths.complete, true);

    const nonEmpty = await createResultCapsule(rawCapsuleOptions(root, { changedPaths: ["src/a.txt", "src/b.txt"] }));
    assert.equal(nonEmpty.capsule.changedPaths.status, "complete");

    const incomplete = await createResultCapsule(rawCapsuleOptions(root, {
      changedPaths: { items: ["src/a.txt"], complete: false, rawLocator: "evidence.txt" },
    }));
    assert.equal(incomplete.capsule.changedPaths.status, "incomplete");
    assert.equal(incomplete.capsule.changedPaths.complete, false);
    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, {
      changedPaths: { items: ["src/a.txt"], complete: false },
    })), /requires a raw locator/);
    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, {
      changedPaths: { items: ["src/a.txt"], complete: true, omittedCount: 1, rawLocator: "evidence.txt" },
    })), /contradicts/);
    const truncated = await createResultCapsule(rawCapsuleOptions(root, {
      changedPaths: { items: Array.from({ length: 100 }, (_, index) => `src/${index}.txt`), rawLocator: "evidence.txt" },
    }));
    assert.equal(truncated.capsule.changedPaths.status, "incomplete");
    assert.equal(truncated.capsule.truncation.changedPaths, true);
    const contradictory = { ...truncated.capsule, changedPaths: { items: [], omittedCount: 1, status: "complete", complete: true, rawLocator: "evidence.txt" } };
    assert.equal((await validateResultCapsule(contradictory, { root })).valid, false);
  });
});

test("AC-7/AC-8/AC-9/AC-10/AC-11: envelope preflight, v2 identity, durable stops, and legacy preservation", async () => {
  await withFixture(async (root) => {
    const invalid = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0 })],
      result: "invalid-envelope.json",
      artifactDir: "raw/invalid-envelope",
      suspensionAvailable: true,
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(invalid.status, "STOPPED_INVALID_ENVELOPE");
    assert.equal(invalid.dispatchCount, 0);
    assert.equal(invalid.dispatchIdentityHash, null);
    assert.equal(invalid.rawRequestDigest.length, 64);
    assert.equal(await fs.stat(path.join(root, "raw/invalid-envelope/job.v1.json")).then(() => true), true);
    assert.equal(await fs.stat(path.join(root, "raw/invalid-envelope/adapter-envelope-stop.v1.json")).then(() => true), true);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
    await assert.rejects(fs.stat(path.join(root, "invalid-envelope.json")));
    const stopBytes = await fs.readFile(path.join(root, "raw/invalid-envelope/adapter-envelope-stop.v1.json"));
    const jobBytes = await fs.readFile(path.join(root, "raw/invalid-envelope/job.v1.json"));
    const reusedStop = await new ProcessJobController({
      root,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0 })],
      result: "invalid-envelope.json",
      artifactDir: "raw/invalid-envelope",
      suspensionAvailable: true,
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(reusedStop.status, "STOPPED_INVALID_ENVELOPE");
    assert.equal(reusedStop.reused, true);
    assert.deepEqual(await fs.readFile(path.join(root, "raw/invalid-envelope/adapter-envelope-stop.v1.json")), stopBytes);
    assert.deepEqual(await fs.readFile(path.join(root, "raw/invalid-envelope/job.v1.json")), jobBytes);

    const correctedSameDirectory = await new ProcessJobController({
      root,
      adapterEnvelope,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0 })],
      result: "invalid-envelope.json",
      artifactDir: "raw/invalid-envelope",
      suspensionAvailable: true,
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(correctedSameDirectory.status, "FAIL");
    assert.equal(correctedSameDirectory.dispatchCount, 0);
    assert.match(correctedSameDirectory.reason, /raw request digest/);
    assert.deepEqual(await fs.readFile(path.join(root, "raw/invalid-envelope/adapter-envelope-stop.v1.json")), stopBytes);
    assert.deepEqual(await fs.readFile(path.join(root, "raw/invalid-envelope/job.v1.json")), jobBytes);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));

    const identityRoots = [await fixture(), await fixture()];
    try {
      await fs.mkdir(path.join(identityRoots[1], "subdir"));
      const identityArgs = [];
      const identityResult = "identity.json";
      const identityArtifact = "raw/identity";
      const identityTimeoutMs = 5000;
      const rootCwd = await new ProcessJobController({
        root: identityRoots[0],
        adapterEnvelope,
        adapter: process.execPath,
        args: identityArgs,
        result: identityResult,
        artifactDir: identityArtifact,
        suspensionAvailable: false,
        timeoutMs: identityTimeoutMs,
      }).dispatch();
      const descendantCwd = await new ProcessJobController({
        root: identityRoots[1],
        adapterEnvelope: { ...adapterEnvelope, effectiveWorkingDirectory: "subdir" },
        adapter: process.execPath,
        args: identityArgs,
        result: identityResult,
        artifactDir: identityArtifact,
        suspensionAvailable: false,
        timeoutMs: identityTimeoutMs,
      }).dispatch();
      const rootJob = JSON.parse(await fs.readFile(path.join(identityRoots[0], identityArtifact, "job.v1.json"), "utf8"));
      const descendantJob = JSON.parse(await fs.readFile(path.join(identityRoots[1], identityArtifact, "job.v1.json"), "utf8"));
      assert.equal(rootCwd.dispatchIdentitySchema, "dd.dispatch-identity.v2");
      assert.equal(descendantCwd.dispatchIdentitySchema, "dd.dispatch-identity.v2");
      assert.equal(rootJob.resultPath, descendantJob.resultPath);
      assert.equal(rootJob.artifactDir, descendantJob.artifactDir);
      assert.equal(rootJob.adapter, descendantJob.adapter);
      assert.equal(rootJob.adapterEnvelope.effectiveWorkingDirectory, ".");
      assert.equal(descendantJob.adapterEnvelope.effectiveWorkingDirectory, "subdir");
      assert.notEqual(rootJob.adapterEnvelope.normalizedDigest, descendantJob.adapterEnvelope.normalizedDigest);
      assert.notEqual(rootCwd.dispatchIdentityHash, descendantCwd.dispatchIdentityHash);
    } finally {
      for (const identityRoot of identityRoots) await fs.rm(identityRoot, { recursive: true, force: true });
    }

    const legacyJobPath = path.join(root, "raw/legacy/job.v1.json");
    await fs.mkdir(path.dirname(legacyJobPath), { recursive: true });
    const legacyBytes = Buffer.from(JSON.stringify({ schemaVersion: "dd.process-job.v1", dispatchIdentitySchema: "dd.dispatch-identity.v1", dispatchId: "legacy", idempotencyKey: "legacy-key", state: "COMPLETED" }));
    await fs.writeFile(legacyJobPath, legacyBytes);
    const legacy = await new ProcessJobController({
      root,
      adapterEnvelope,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0 })],
      result: "legacy-result.json",
      artifactDir: "raw/legacy",
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(legacy.status, "FAIL");
    assert.equal(legacy.dispatchCount, 0);
    assert.deepEqual(await fs.readFile(legacyJobPath), legacyBytes);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));

    const correctedFreshDirectory = await new ProcessJobController({
      root,
      adapterEnvelope,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0 }, { resultPath: "corrected-result.json" })],
      result: "corrected-result.json",
      artifactDir: "raw/corrected-envelope",
      suspensionAvailable: true,
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(correctedFreshDirectory.status, "PASS");
    assert.equal(correctedFreshDirectory.dispatchCount, 1);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
    assert.equal((await fs.stat(path.join(root, "corrected-result.json"))).isFile(), true);
  });
});

test("Correction 2/AC-8: malformed, out-of-root, contradictory, and unmodelled --cd envelopes stop durably", async () => {
  await withFixture(async (root) => {
    const cases = [
      ["malformed", "not-a-json-object"],
      ["out-of-root", { ...adapterEnvelope, effectiveWorkingDirectory: "../outside" }],
      ["contradictory", {
        ...adapterEnvelope,
        adapterContract: { adapter: process.execPath, cwdArgument: "--cd", cwdValue: "." },
      }],
      ["inherits-cd-separated", adapterEnvelope, ["-e", adapterProgram({ status: "completed", exitCode: 0 }), "--cd", "."]],
      ["inherits-cd-equals", adapterEnvelope, ["-e", adapterProgram({ status: "completed", exitCode: 0 }), "--cd=."]],
    ];
    for (const [name, envelope, args] of cases) {
      await assertInvalidEnvelopeStop(root, name, envelope, args);
    }
  });
});

test("Correction 2/AC-8: a reparse-crossing effective cwd stops before provider launch", async (t) => {
  await withFixture(async (root) => {
    const linked = path.join(root, "linked-cwd");
    try {
      await fs.symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(error.code)) {
        t.skip(`cannot create the reparse fixture on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    await assertInvalidEnvelopeStop(root, "reparse-crossing", { ...adapterEnvelope, effectiveWorkingDirectory: "linked-cwd" });
  });
});

test("Correction 5/AC-8: adapter_contract accepts real --cd and rejects duplicate or contradictory declarations", async () => {
  await withFixture(async (root) => {
    const result = await new ProcessJobController({
      root,
      adapterEnvelope: adapterContractEnvelope,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "contract" }, { resultPath: "contract-result.json" }), "--", "--cd", "."],
      result: "contract-result.json",
      artifactDir: "raw/contract",
      expectedSession: "contract",
      suspensionAvailable: true,
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(result.status, "PASS");
    assert.equal(result.dispatchCount, 1);
    assert.deepEqual(result.capsule.adapterEnvelope.adapterContract, adapterContractEnvelope.adapterContract);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });

  await withFixture(async (root) => {
    await assertInvalidEnvelopeStop(root, "duplicate-cd", adapterContractEnvelope, [
      "-e", adapterProgram({ status: "completed", exitCode: 0 }), "--cd", ".", "--cd", ".",
    ]);
  });

  await withFixture(async (root) => {
    await assertInvalidEnvelopeStop(root, "undeclared-cwd", adapterContractEnvelope, [
      "-e", adapterProgram({ status: "completed", exitCode: 0 }), "--", "--cd", ".", "--workdir", "../outside",
    ]);
  });

  await withFixture(async (root) => {
    const contradictory = {
      ...adapterContractEnvelope,
      adapterContract: { ...adapterContractEnvelope.adapterContract, argument: "--cwd" },
    };
    await assertInvalidEnvelopeStop(root, "contradictory-cd", contradictory, [
      "-e", adapterProgram({ status: "completed", exitCode: 0 }), "--cd", ".",
    ]);
  });
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

    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, {
      dispatchId: "dispatch-enforced",
      idempotencyKey: "idem-enforced",
      suspensionStatus: "enforced",
      hostTelemetry: { leadModelTurnsBetweenDispatchAndTerminal: 0 },
      suspensionEvidence: { basis: "host telemetry", hostTelemetry: { leadModelTurnsBetweenDispatchAndTerminal: 0 } },
    })), /current controller cannot emit enforced/);
    await assert.rejects(createResultCapsule(rawCapsuleOptions(root, {
      dispatchId: "dispatch-invalid-suspension",
      idempotencyKey: "idem-invalid-suspension",
      suspensionStatus: "enforced",
    })), /zero Lead model turns/);
    const legacyEnforced = {
      ...emitted.capsule,
      suspensionStatus: "enforced",
      hostTelemetry: { leadModelTurnsBetweenDispatchAndTerminal: 0 },
      suspensionEvidence: { basis: "legacy raw capsule", hostTelemetry: { leadModelTurnsBetweenDispatchAndTerminal: 0 } },
    };
    const legacyValidation = await validateResultCapsule(legacyEnforced, { root });
    assert.equal(legacyValidation.valid, true);
    assert.equal(legacyValidation.attestation, "non-attested");
    assert.equal(legacyValidation.suspensionAttestation, "non-attested");
  });
  assert.deepEqual(roleStatuses("executor"), ["READY_FOR_VERIFICATION", "FAILED"]);
  assert.deepEqual(roleStatuses("planner"), ["APPROVE", "BLOCK", "NEEDS_EVIDENCE", "TRANSPORT_FAILED"]);
  assert.deepEqual(roleStatuses("mechanical"), ["PASS", "FAIL", "UNKNOWN"]);
});

test("AC-9/AC-10: uncertain restart, session mismatch, and timeout fail closed with explicit process coverage", async () => {
  await withFixture(async (root) => {
    await fs.mkdir(path.join(root, "raw/uncertain"), { recursive: true });
    await write(root, "raw/uncertain/job.v1.json", JSON.stringify({ schemaVersion: "dd.process-job.v1", dispatchId: "old", idempotencyKey: "old-key", state: "DISPATCHING" }));
    const uncertain = await new ProcessJobController({ root, adapterEnvelope, adapter: process.execPath, args: ["-e", adapterProgram({ status: "completed", exitCode: 0 }, { count: false })], result: "result.json", artifactDir: "raw/uncertain", idempotencyKey: "old-key", timeoutMs: 5000 }).dispatch();
    assert.equal(uncertain.status, "UNKNOWN");
    assert.equal(uncertain.dispatchCount, 0);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));

    const mismatch = await new ProcessJobController({
      root,
      adapterEnvelope,
      adapter: process.execPath,
      args: ["-e", adapterProgram({ status: "completed", exitCode: 0, sessionId: "other" }, { resultPath: "mismatch.json" })],
      result: "mismatch.json",
      artifactDir: "raw/mismatch",
      role: "planner",
      roleStatus: "APPROVE",
      expectedSession: "expected",
      timeoutMs: 5000,
    }).dispatch();
    assert.equal(mismatch.status, "FAIL");
    assert.equal(mismatch.capsule.roleStatus, "TRANSPORT_FAILED");
    assert.equal(mismatch.sessionVerification, "mismatch");
    assert.match(mismatch.failureReasons.join(" "), /expected session/);
    assert.match(mismatch.capsule.process.processTreeTermination, /child-only/);

    const timeout = await new ProcessJobController({
      root,
      adapterEnvelope,
      adapter: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      result: "timeout.json",
      artifactDir: "raw/timeout",
      role: "planner",
      roleStatus: "APPROVE",
      timeoutMs: 100,
    }).dispatch();
    assert.equal(timeout.status, "FAIL");
    assert.equal(timeout.capsule.roleStatus, "TRANSPORT_FAILED");
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
