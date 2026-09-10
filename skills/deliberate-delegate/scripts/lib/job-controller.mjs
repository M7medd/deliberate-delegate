import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  TERMINAL_STATUSES,
  absoluteFromRelative,
  assertNoReparseCrossing,
  assertRelativeInput,
  createFreshDirectory,
  ensureParent,
  extractSessionRefs,
  fail,
  readOwnedFile,
  realDirectory,
  runCapture,
  sha256Bytes,
  stableJson,
  validateResultArtifact,
  writeNewFile,
} from "./lifecycle-core.mjs";
import { emitResultCapsule, loadAndValidateCapsule } from "./result-capsule.mjs";

export const JOB_CONTROLLER_SCHEMA = "dd.process-job.v1";

function text(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function now() {
  return new Date().toISOString();
}

function pathsOverlap(left, right) {
  const normalize = (value) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function dispatchIdentityHash(options, { resultRelative, artifactRelative, jobRelative, capsuleRelative }) {
  const identity = {
    schemaVersion: "dd.dispatch-identity.v1",
    role: options.role,
    adapter: options.adapter,
    args: options.args,
    resultPath: resultRelative,
    expectedSession: options.expectedSession,
    artifactDir: artifactRelative,
    jobRecord: jobRelative,
    capsulePath: capsuleRelative,
    timeoutMs: options.timeoutMs,
  };
  return sha256Bytes(stableJson(identity));
}

async function existsRegular(root, relative) {
  try {
    await assertNoReparseCrossing(root, relative, { allowMissing: false, includeFinal: true });
    const stat = await fsp.lstat(absoluteFromRelative(root, relative));
    return stat.isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonIfPresent(root, relative) {
  if (!(await existsRegular(root, relative))) return null;
  try {
    return JSON.parse((await readOwnedFile(root, relative, "JSON record")).toString("utf8"));
  } catch (error) {
    return { __malformed: error.message };
  }
}

export function resolveSuspensionStatus({ available, hostTelemetry } = {}) {
  if (available === false) {
    return {
      suspensionStatus: "unavailable",
      shouldStop: true,
      evidence: { basis: "host did not provide the required suspend-and-await facility" },
      hostTelemetry: hostTelemetry ?? null,
    };
  }
  if (available === true && hostTelemetry?.leadModelTurnsBetweenDispatchAndTerminal === 0) {
    return {
      suspensionStatus: "enforced",
      shouldStop: false,
      evidence: { basis: "explicit host telemetry", hostTelemetry },
      hostTelemetry,
    };
  }
  return {
    suspensionStatus: "unknown",
    shouldStop: false,
    evidence: { basis: "owned child-process wait completed; host telemetry did not prove zero Lead model turns" },
    hostTelemetry: hostTelemetry ?? null,
  };
}

function resultStatusForCapsule(parsed, validation) {
  if (validation.valid) return validation.status;
  // A failure capsule is terminal as a report about the failed dispatch. The
  // raw artifact and validation reason remain evidence; never relabel a raw
  // nonterminal provider result as completed.
  return "error";
}

function processStatusForCapsule(processResult) {
  if (processResult.timedOut) return "timeout";
  if (processResult.spawnError) return "error";
  if (processResult.code === 0) return "completed";
  return "failed";
}

async function waitForResultEvent(root, relative) {
  const parentRelative = path.posix.dirname(relative);
  const parent = absoluteFromRelative(root, parentRelative === "." ? "." : parentRelative);
  const basename = path.posix.basename(relative);
  try {
    let observedAt = null;
    const watcher = fs.watch(parent, { persistent: false }, (_event, name) => {
      if (name === undefined || String(name) === basename) observedAt ??= now();
    });
    return {
      watcher,
      observed: () => observedAt,
      close: () => watcher.close(),
    };
  } catch (error) {
    return {
      watcher: null,
      observed: () => null,
      close: () => {},
      unavailable: error.message,
    };
  }
}

function normalizeOptions(options) {
  const result = options.result ?? options.resultPath ?? options.rawResult;
  if (!result) throw new Error("result or resultPath is required");
  const adapter = options.adapter ?? options.command;
  if (!adapter) throw new Error("adapter or command is required");
  const args = options.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("args must be an array of strings");
  const suspensionAvailable = options.suspensionAvailable ?? (options.suspension?.status === "unavailable" ? false : options.suspension?.available);
  const hostTelemetry = options.hostTelemetry ?? options.suspension?.hostTelemetry;
  return {
    ...options,
    adapter: text(adapter, "adapter"),
    args,
    result: result,
    role: options.role ?? "executor",
    artifactDir: options.artifactDir ?? `.dd-efficiency/jobs/job-${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`,
    expectedSession: options.expectedSession ?? options.requestedSessionId ?? null,
    suspensionAvailable,
    hostTelemetry,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxCapsuleBytes: options.maxCapsuleBytes,
  };
}

export class ProcessJobController {
  #options;
  #dispatchPromise = null;

  constructor(options = {}) {
    this.#options = normalizeOptions(options);
  }

  dispatch() {
    // The promise itself is the one-dispatch guard. Concurrent callers share
    // the same owned child wait; a second call never starts another worker.
    this.#dispatchPromise ??= this.#dispatchOnce();
    return this.#dispatchPromise;
  }

  run() {
    return this.dispatch();
  }

  async #dispatchOnce() {
    const options = this.#options;
    const root = await realDirectory(options.root, "root");
    const resultRelative = assertRelativeInput(options.result, "result artifact");
    const artifactRelative = assertRelativeInput(options.artifactDir, "artifact directory");
    const jobRelative = assertRelativeInput(options.jobRecord ?? `${artifactRelative}/job.v1.json`, "job record");
    const capsuleRelative = assertRelativeInput(options.capsule ?? `${artifactRelative}/capsule.v1.json`, "capsule output");
    if (pathsOverlap(resultRelative, artifactRelative) || pathsOverlap(resultRelative, jobRelative) || pathsOverlap(resultRelative, capsuleRelative)) {
      fail("result, job, and capsule paths must not overlap the owned artifact path", "E_SCOPE_OVERLAP");
    }
    const identityHash = dispatchIdentityHash(options, { resultRelative, artifactRelative, jobRelative, capsuleRelative });
    const dispatchId = options.dispatchId ?? crypto.randomUUID();
    const idempotencyKey = text(options.idempotencyKey ?? `dd:${identityHash}`, "idempotencyKey");
    const suspension = resolveSuspensionStatus({ available: options.suspensionAvailable, hostTelemetry: options.hostTelemetry });

    let artifactExists = false;
    try {
      await fsp.lstat(absoluteFromRelative(root, artifactRelative));
      artifactExists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (!artifactExists && await existsRegular(root, resultRelative)) {
      return {
        schemaVersion: JOB_CONTROLLER_SCHEMA,
        status: "FAIL",
        dispatchCount: 0,
        dispatchId,
        idempotencyKey,
        dispatchIdentityHash: identityHash,
        reason: "stale pre-existing result artifact; refusing to dispatch",
        resultPath: resultRelative,
        suspensionStatus: suspension.suspensionStatus,
      };
    }

    if (artifactExists) {
      await assertNoReparseCrossing(root, artifactRelative, { allowMissing: false, includeFinal: true });
      const previousJob = await readJsonIfPresent(root, jobRelative);
      if (!previousJob || previousJob.__malformed) {
        return {
          schemaVersion: JOB_CONTROLLER_SCHEMA,
          status: "UNKNOWN",
          dispatchCount: 0,
          dispatchId,
          idempotencyKey,
          dispatchIdentityHash: identityHash,
          reason: previousJob?.__malformed || "existing artifact directory has no valid job record; reconciliation required",
          suspensionStatus: "unknown",
        };
      }
      const identityMismatches = [];
      if (previousJob.idempotencyKey !== idempotencyKey) identityMismatches.push("idempotency key does not match the persisted job record");
      if (previousJob.dispatchIdentityHash && previousJob.dispatchIdentityHash !== identityHash) identityMismatches.push("dispatch identity does not match the persisted job record");
      if (options.dispatchId && previousJob.dispatchId !== dispatchId) identityMismatches.push("dispatch ID does not match the persisted job record");
      if (identityMismatches.length > 0) {
        return {
          schemaVersion: JOB_CONTROLLER_SCHEMA,
          status: "FAIL",
          dispatchCount: 0,
          dispatchId,
          idempotencyKey,
          dispatchIdentityHash: identityHash,
          reason: identityMismatches.join("; "),
          suspensionStatus: "unknown",
        };
      }
      const existing = await loadAndValidateCapsule(root, capsuleRelative, { expectedSession: options.expectedSession, verifyRaw: true });
      if (existing.valid) {
        const capsuleIdentityMismatches = [];
        if (existing.capsule.dispatchId !== previousJob.dispatchId) capsuleIdentityMismatches.push("capsule dispatchId does not match the persisted job");
        if (existing.capsule.idempotencyKey !== previousJob.idempotencyKey) capsuleIdentityMismatches.push("capsule idempotencyKey does not match the persisted job");
        if (existing.capsule.dispatchIdentityHash && previousJob.dispatchIdentityHash && existing.capsule.dispatchIdentityHash !== previousJob.dispatchIdentityHash) capsuleIdentityMismatches.push("capsule dispatch identity does not match the persisted job");
        if (capsuleIdentityMismatches.length > 0) {
          return {
            schemaVersion: JOB_CONTROLLER_SCHEMA,
            status: "FAIL",
            dispatchCount: 0,
            dispatchId,
            idempotencyKey,
            dispatchIdentityHash: identityHash,
            reason: capsuleIdentityMismatches.join("; "),
            capsulePath: capsuleRelative,
            suspensionStatus: "unknown",
          };
        }
        return {
          schemaVersion: JOB_CONTROLLER_SCHEMA,
          status: "REUSED",
          dispatchCount: 0,
          reused: true,
          dispatchId: previousJob.dispatchId,
          idempotencyKey: previousJob.idempotencyKey,
          dispatchIdentityHash: previousJob.dispatchIdentityHash ?? identityHash,
          capsulePath: capsuleRelative,
          capsule: existing.capsule,
          suspensionStatus: existing.capsule.suspensionStatus,
        };
      }
      return {
        schemaVersion: JOB_CONTROLLER_SCHEMA,
        status: "UNKNOWN",
        dispatchCount: 0,
        dispatchId: previousJob.dispatchId,
        idempotencyKey: previousJob.idempotencyKey,
        dispatchIdentityHash: previousJob.dispatchIdentityHash ?? identityHash,
        reason: `existing job is not a verified terminal result: ${existing.errors.join("; ")}`,
        capsulePath: capsuleRelative,
        suspensionStatus: "unknown",
      };
    }

    const artifactDir = await createFreshDirectory(root, artifactRelative);
    const jobRecord = {
      schemaVersion: JOB_CONTROLLER_SCHEMA,
      dispatchId,
      idempotencyKey,
      dispatchIdentityHash: identityHash,
      createdAt: now(),
      role: options.role,
      adapter: options.adapter,
      resultPath: resultRelative,
      artifactDir: artifactRelative,
      capsulePath: capsuleRelative,
      requestedSessionId: options.expectedSession,
      suspensionStatus: suspension.suspensionStatus,
      state: suspension.shouldStop ? "STOPPED_UNAVAILABLE" : "DISPATCHING",
    };
    await writeNewFile(root, jobRelative, `${JSON.stringify(jobRecord, null, 2)}\n`);

    if (suspension.shouldStop) {
      const stopRecord = {
        schemaVersion: "dd.suspension-stop.v1",
        dispatchId,
        idempotencyKey,
        dispatchIdentityHash: identityHash,
        createdAt: jobRecord.createdAt,
        status: "UNAVAILABLE",
        suspensionStatus: "unavailable",
        evidence: suspension.evidence,
        reason: "suspension is unavailable; no worker was dispatched and no model-polling fallback is permitted",
        capsulePath: null,
      };
      const stopPath = `${artifactRelative}/suspension-stop.v1.json`;
      await writeNewFile(root, stopPath, `${JSON.stringify(stopRecord, null, 2)}\n`);
      return { ...stopRecord, dispatchCount: 0, artifactDir: artifactRelative, stopPath };
    }

    await ensureParent(root, resultRelative);
    const resultWatcher = await waitForResultEvent(root, resultRelative);
    const processResult = await runCapture(options.adapter, options.args, {
      cwd: root,
      stdoutPath: path.join(artifactDir, "adapter.stdout.log"),
      stderrPath: path.join(artifactDir, "adapter.stderr.log"),
      timeoutMs: options.timeoutMs,
    });
    const resultObservedAt = resultWatcher.observed();
    resultWatcher.close();

    let parsed = null;
    let resultError = null;
    try {
      parsed = JSON.parse((await readOwnedFile(root, resultRelative, "result artifact")).toString("utf8"));
    } catch (error) {
      resultError = error.code === "ENOENT" ? "missing result artifact" : `malformed result artifact: ${error.message}`;
    }
    const validation = parsed ? validateResultArtifact(parsed) : { valid: false, reason: resultError };
    const observedSessionIds = parsed ? extractSessionRefs(parsed).map((item) => item.value) : [];
    const sessionVerification = options.expectedSession === null
      ? "not_requested"
      : observedSessionIds.includes(options.expectedSession) ? "matched" : "mismatch";
    const processStatus = processStatusForCapsule(processResult);
    const resultStatus = resultStatusForCapsule(parsed, validation);
    const success = !processResult.spawnError && !processResult.timedOut && !processResult.logDrainTimedOut && processResult.code === 0 && validation.valid && validation.status === "completed" && sessionVerification !== "mismatch";
    const roleStatus = options.role === "planner"
      ? (options.roleStatus ?? "NEEDS_EVIDENCE")
      : options.role === "mechanical" ? (success ? "PASS" : "FAIL") : (success ? "READY_FOR_VERIFICATION" : "FAILED");
    const rawArtifacts = [
      { kind: "adapter-stdout", locator: `${artifactRelative}/adapter.stdout.log` },
      { kind: "adapter-stderr", locator: `${artifactRelative}/adapter.stderr.log` },
    ];
    if (await existsRegular(root, resultRelative)) rawArtifacts.push({ kind: "provider-result", locator: resultRelative });
    const capsule = await emitResultCapsule(root, capsuleRelative, {
      dispatchId,
      idempotencyKey,
      dispatchIdentityHash: identityHash,
      role: options.role,
      roleStatus,
      adapter: options.adapter,
      createdAt: jobRecord.createdAt,
      completedAt: now(),
      terminal: true,
      capsuleStatus: "TERMINAL",
      process: {
        terminalStatus: processStatus,
        exitCode: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        logDrainTimedOut: processResult.logDrainTimedOut,
        processTreeTermination: processResult.processTreeTermination,
      },
      result: { terminalStatus: resultStatus, exitCode: parsed?.exitCode ?? processResult.code ?? null },
      resultValidation: { valid: validation.valid, reason: validation.reason ?? resultError ?? null, status: validation.status ?? null },
      requestedSessionId: options.expectedSession,
      observedSessionIds,
      sessionVerification,
      suspensionStatus: suspension.suspensionStatus,
      suspensionEvidence: { ...suspension.evidence, resultObservedBeforeProcessExit: Boolean(resultObservedAt), resultWatch: resultWatcher.unavailable ? "unavailable" : "filesystem-event" },
      hostTelemetry: suspension.hostTelemetry,
      rawArtifacts,
      changedPaths: options.changedPaths ?? [],
      gateCoverage: options.gateCoverage ?? {},
      providerUsage: parsed?.usage,
      maxBytes: options.maxCapsuleBytes,
    });
    const failureReasons = [];
    if (processResult.spawnError) failureReasons.push(`adapter spawn failed: ${processResult.spawnError.message}`);
    if (processResult.timedOut) failureReasons.push("adapter timeout");
    if (processResult.logDrainTimedOut) failureReasons.push("log drain timed out; raw logs may be incomplete and descendants may still be running");
    if (processResult.code !== 0) failureReasons.push(`adapter exit code ${processResult.code ?? processResult.signal ?? "unknown"}`);
    if (!validation.valid) failureReasons.push(validation.reason || resultError || "invalid result artifact");
    if (validation.valid && validation.status !== "completed") failureReasons.push(`adapter status ${parsed.status}`);
    if (sessionVerification === "mismatch") failureReasons.push(`expected session ${options.expectedSession} was not found in explicit provider fields`);
    return {
      schemaVersion: JOB_CONTROLLER_SCHEMA,
      status: success ? "PASS" : "FAIL",
      dispatchCount: 1,
      reused: false,
      dispatchId,
      idempotencyKey,
      dispatchIdentityHash: identityHash,
      resultPath: resultRelative,
      capsulePath: capsule.capsulePath,
      capsule: capsule.capsule,
      resultValidation: { valid: validation.valid, reason: validation.reason ?? null, status: validation.status ?? null },
      sessionVerification,
      suspensionStatus: suspension.suspensionStatus,
      resultObservedBeforeProcessExit: Boolean(resultObservedAt),
      failureReasons,
      process: {
        exitCode: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        logDrainTimedOut: processResult.logDrainTimedOut,
        processTreeTermination: processResult.processTreeTermination,
      },
    };
  }
}

export async function dispatchProcessJob(options) {
  return new ProcessJobController(options).dispatch();
}

export { TERMINAL_STATUSES };
