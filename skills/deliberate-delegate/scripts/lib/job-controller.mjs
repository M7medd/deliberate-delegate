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
  hashRegularFile,
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
export const ADAPTER_ENVELOPE_SCHEMA = "dd.adapter-envelope.v1";
export const DISPATCH_IDENTITY_SCHEMA = "dd.dispatch-identity.v2";
const ADAPTER_ENVELOPE_LIMITATION = "declaration/contract evidence only; argv and adapter cwd behavior are not OS attestation";

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

function dispatchIdentity(options, { resultRelative, artifactRelative, jobRelative, capsuleRelative, adapterEnvelopeDigest }) {
  const identity = {
    schemaVersion: DISPATCH_IDENTITY_SCHEMA,
    role: options.role,
    adapter: options.adapter,
    args: options.args,
    resultPath: resultRelative,
    expectedSession: options.expectedSession,
    artifactDir: artifactRelative,
    jobRecord: jobRelative,
    capsulePath: capsuleRelative,
    timeoutMs: options.timeoutMs,
    adapterEnvelopeDigest,
  };
  return identity;
}

function dispatchIdentityHash(options, paths) {
  return sha256Bytes(stableJson(dispatchIdentity(options, paths)));
}

function rawRequestDigest(options, { resultRelative, artifactRelative, jobRelative, capsuleRelative }) {
  return sha256Bytes(stableJson({
    schemaVersion: "dd.dispatch-request.v2",
    role: options.role,
    adapter: options.adapter,
    args: options.args,
    resultPath: resultRelative,
    expectedSession: options.expectedSession,
    artifactDir: artifactRelative,
    jobRecord: jobRelative,
    capsulePath: capsuleRelative,
    timeoutMs: options.timeoutMs,
    adapterEnvelope: options.adapterEnvelope ?? null,
    adapterEnvelopeSourceFile: options.adapterEnvelopeSourceFile ?? null,
    adapterEnvelopeSourceDigest: options.adapterEnvelopeSourceDigest ?? null,
    adapterEnvelopeSourceError: options.adapterEnvelopeSourceError ?? null,
  }));
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function boundedText(value, label, max = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(`${label} must be a non-empty string of at most ${max} characters`, "E_ADAPTER_ENVELOPE");
  }
  return value;
}

function consistentAlias(value, aliases, label) {
  const present = aliases.filter((alias) => hasOwn(value, alias));
  if (present.length === 0) return undefined;
  const selected = value[present[0]];
  for (const alias of present.slice(1)) {
    if (stableJson(value[alias]) !== stableJson(selected)) {
      fail(`${label} has contradictory declarations`, "E_ADAPTER_ENVELOPE");
    }
  }
  return selected;
}

function adapterLabel(value) {
  const normalized = String(value).replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  return normalized.endsWith(".exe") ? normalized.slice(0, -4) : normalized;
}

function adapterNamesMatch(declared, actual) {
  return declared === actual || adapterLabel(declared) === adapterLabel(actual);
}

function knownCwdArgumentOccurrences(args, cwdArgument) {
  const occurrences = [];
  const exact = String(cwdArgument);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === exact) {
      occurrences.push({ index, value: args[index + 1], form: "separate" });
    } else if (argument.startsWith(`${exact}=`)) {
      occurrences.push({ index, value: argument.slice(exact.length + 1), form: "equals" });
    }
  }
  return occurrences;
}

function unmodelledCwdArgument(args) {
  const known = ["--cwd", "--workdir", "--working-directory", "--cd", "-C"];
  return args.find((argument) => known.some((candidate) => argument === candidate || argument.startsWith(`${candidate}=`))) ?? null;
}

function normalizeAdapterEnvelopeShape(value, { adapter, args } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("adapter envelope must be a JSON object", "E_ADAPTER_ENVELOPE");
  }
  if (value.schemaVersion !== ADAPTER_ENVELOPE_SCHEMA) {
    fail(`adapter envelope schemaVersion must be ${ADAPTER_ENVELOPE_SCHEMA}`, "E_ADAPTER_ENVELOPE");
  }
  const effectiveWorkingDirectory = assertRelativeInput(value.effectiveWorkingDirectory, "adapter envelope effectiveWorkingDirectory");
  const cwdMode = value.cwdMode;
  if (cwdMode !== "inherits_process" && cwdMode !== "adapter_contract") {
    fail("adapter envelope cwdMode must be inherits_process or adapter_contract", "E_ADAPTER_ENVELOPE");
  }
  const adapterContractValue = value.adapterContract;
  if (cwdMode === "inherits_process") {
    if (adapterContractValue !== null) {
      fail("inherits_process adapter envelopes require adapterContract=null", "E_ADAPTER_ENVELOPE");
    }
    const unmodelled = unmodelledCwdArgument(args || []);
    if (unmodelled !== null) {
      fail(`adapter envelope declares inherits_process but argv contains an unmodelled cwd override: ${unmodelled}`, "E_ADAPTER_ENVELOPE");
    }
    return {
      schemaVersion: ADAPTER_ENVELOPE_SCHEMA,
      effectiveWorkingDirectory,
      cwdMode,
      adapterContract: null,
    };
  }

  if (!adapterContractValue || typeof adapterContractValue !== "object" || Array.isArray(adapterContractValue)) {
    fail("adapter_contract envelopes require bounded adapterContract metadata", "E_ADAPTER_ENVELOPE");
  }
  const declaredAdapter = consistentAlias(adapterContractValue, ["adapter", "name", "adapterName"], "adapterContract adapter");
  const cwdArgument = consistentAlias(adapterContractValue, ["cwdArgument", "cwdArg", "argument"], "adapterContract cwd argument");
  const cwdValue = consistentAlias(adapterContractValue, ["cwdValue", "value", "cwd"], "adapterContract cwd value");
  boundedText(declaredAdapter, "adapterContract adapter");
  boundedText(cwdArgument, "adapterContract cwd argument", 128);
  boundedText(cwdValue, "adapterContract cwd value", 512);
  if (!adapterNamesMatch(declaredAdapter, adapter)) {
    fail("adapterContract adapter does not name the supplied adapter executable", "E_ADAPTER_ENVELOPE");
  }
  const normalizedCwdValue = assertRelativeInput(cwdValue, "adapterContract cwd value");
  if (normalizedCwdValue !== effectiveWorkingDirectory) {
    fail("adapterContract cwd value contradicts effectiveWorkingDirectory", "E_ADAPTER_ENVELOPE");
  }
  const occurrences = knownCwdArgumentOccurrences(args || [], cwdArgument);
  if (occurrences.length === 0) {
    fail("adapterContract cwd argument is not present in the supplied argv", "E_ADAPTER_ENVELOPE");
  }
  if (occurrences.length !== 1) {
    fail("adapterContract cwd argument is duplicated in the supplied argv", "E_ADAPTER_ENVELOPE");
  }
  const occurrence = occurrences[0];
  if (occurrence.form === "separate" && typeof occurrence.value !== "string") {
    fail("adapterContract cwd argument is missing its value in the supplied argv", "E_ADAPTER_ENVELOPE");
  }
  if (occurrence.value !== cwdValue && assertRelativeInput(occurrence.value, "adapter argv cwd value") !== normalizedCwdValue) {
    fail("adapterContract cwd argument/value does not match the supplied argv", "E_ADAPTER_ENVELOPE");
  }
  const remainingArgs = (args || []).filter((_, index) => index !== occurrence.index && (occurrence.form !== "separate" || index !== occurrence.index + 1));
  const undeclaredCwd = unmodelledCwdArgument(remainingArgs);
  if (undeclaredCwd !== null) {
    fail(`adapterContract argv contains an undeclared cwd mechanism: ${undeclaredCwd}`, "E_ADAPTER_ENVELOPE");
  }
  return {
    schemaVersion: ADAPTER_ENVELOPE_SCHEMA,
    effectiveWorkingDirectory,
    cwdMode,
    adapterContract: {
      adapter: declaredAdapter,
      cwdArgument,
      cwdValue: normalizedCwdValue,
    },
  };
}

function envelopeRecord(envelope, normalizedDigest, sourceFile, sourceFileDigest) {
  return {
    ...envelope,
    normalizedDigest,
    canonicalDigest: normalizedDigest,
    sourceFile: sourceFile ?? null,
    sourceFileDigest: sourceFileDigest ?? null,
    evidence: "declaration",
    limitation: ADAPTER_ENVELOPE_LIMITATION,
  };
}

async function inspectAdapterEnvelope(root, options) {
  try {
    if (options.adapterEnvelopeSourceError) {
      fail(`adapter envelope source is invalid: ${options.adapterEnvelopeSourceError}`, "E_ADAPTER_ENVELOPE");
    }
    let raw = options.adapterEnvelope;
    let sourceFile = null;
    let sourceFileDigest = null;
    if (options.adapterEnvelopeSourceFile !== null) {
      sourceFile = assertRelativeInput(options.adapterEnvelopeSourceFile, "adapter envelope source file");
      await assertNoReparseCrossing(root, sourceFile, { allowMissing: false, includeFinal: true });
      const bytes = await readOwnedFile(root, sourceFile, "adapter envelope source file");
      sourceFileDigest = sha256Bytes(bytes);
      if (options.adapterEnvelopeSourceDigest !== null && options.adapterEnvelopeSourceDigest !== sourceFileDigest) {
        fail("adapter envelope source digest does not match the source JSON file", "E_ADAPTER_ENVELOPE");
      }
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      } catch (error) {
        fail(`adapter envelope source JSON is malformed: ${error.message}`, "E_ADAPTER_ENVELOPE");
      }
      if (options.adapterEnvelope !== null && stableJson(options.adapterEnvelope) !== stableJson(raw)) {
        fail("adapter envelope object contradicts the source JSON file", "E_ADAPTER_ENVELOPE");
      }
    } else if (options.adapterEnvelopeSourceDigest !== null) {
      fail("direct library adapter envelopes cannot claim a source-file digest", "E_ADAPTER_ENVELOPE");
    }
    const envelope = normalizeAdapterEnvelopeShape(raw, { adapter: options.adapter, args: options.args });
    await assertNoReparseCrossing(root, envelope.effectiveWorkingDirectory, { allowMissing: false, includeFinal: true });
    const cwd = absoluteFromRelative(root, envelope.effectiveWorkingDirectory);
    const cwdStat = await fsp.lstat(cwd);
    if (!cwdStat.isDirectory()) fail("adapter envelope effectiveWorkingDirectory is not a directory", "E_ADAPTER_ENVELOPE");
    const normalizedDigest = sha256Bytes(stableJson(envelope));
    return {
      valid: true,
      envelope,
      normalizedDigest,
      record: envelopeRecord(envelope, normalizedDigest, sourceFile, sourceFileDigest),
      sourceFile,
      sourceFileDigest,
    };
  } catch (error) {
    return {
      valid: false,
      error: error.message,
      code: error.code || "E_ADAPTER_ENVELOPE",
      sourceFile: null,
      sourceFileDigest: null,
    };
  }
}

export async function loadAdapterEnvelopeFile(root, relative) {
  try {
    const projectRoot = await realDirectory(root, "root");
    const sourceFile = assertRelativeInput(relative, "adapter envelope source file");
    await assertNoReparseCrossing(projectRoot, sourceFile, { allowMissing: false, includeFinal: true });
    const bytes = await readOwnedFile(projectRoot, sourceFile, "adapter envelope source file");
    let adapterEnvelope;
    try {
      adapterEnvelope = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      return { adapterEnvelope: null, sourceFile: sourceFile, sourceFileDigest: sha256Bytes(bytes), sourceError: `malformed JSON: ${error.message}` };
    }
    return { adapterEnvelope, sourceFile, sourceFileDigest: sha256Bytes(bytes), sourceError: null };
  } catch (error) {
    return { adapterEnvelope: null, sourceFile: typeof relative === "string" ? relative : null, sourceFileDigest: null, sourceError: error.message };
  }
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
  return {
    suspensionStatus: "unknown",
    shouldStop: false,
    evidence: {
      basis: hostTelemetry?.leadModelTurnsBetweenDispatchAndTerminal === 0
        ? "host telemetry was recorded, but current controller emission cannot assert enforced suspension"
        : "owned child-process wait completed; host telemetry did not prove zero Lead model turns",
    },
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

function transportAssessment({ process, result, resultValidation, requestedSessionId, observedSessionIds, sessionVerification, terminal = true } = {}) {
  const failures = [];
  if (!process || process.spawnError) failures.push("adapter spawn failed");
  if (process?.timedOut) failures.push("adapter timeout");
  if (process?.logDrainTimedOut) failures.push("log drain timed out");
  if (process?.terminalStatus !== "completed") failures.push(`adapter process status ${process?.terminalStatus ?? "unknown"}`);
  if (process?.exitCode !== 0) failures.push(`adapter exit code ${process?.exitCode ?? "unknown"}`);
  if (terminal !== true) failures.push("terminal result was not marked terminal");
  if (!result) failures.push("missing terminal result");
  if (resultValidation && resultValidation.valid !== true) failures.push(resultValidation.reason || "invalid terminal result");
  if (result && String(result.terminalStatus ?? "").toLowerCase() !== "completed") failures.push(`provider result status ${result.terminalStatus ?? "unknown"}`);
  if (result && result.exitCode !== null && result.exitCode !== undefined && result.exitCode !== 0) failures.push(`provider result exit code ${result.exitCode}`);
  if (requestedSessionId !== null && sessionVerification !== "matched") failures.push(`expected session ${requestedSessionId} was not matched`);
  return { succeeded: failures.length === 0, failures };
}

function capsuleRoleStatus(role, callerStatus, transport) {
  if (role === "planner") return transport.succeeded ? callerStatus : "TRANSPORT_FAILED";
  if (role === "mechanical") return transport.succeeded ? "PASS" : "FAIL";
  return transport.succeeded ? "READY_FOR_VERIFICATION" : "FAILED";
}

function invalidEnvelopeResult({ artifactRelative, stopPath, stopRecord, jobRecord, rawDigest, dispatchId, idempotencyKey }) {
  return {
    ...stopRecord,
    schemaVersion: JOB_CONTROLLER_SCHEMA,
    status: "STOPPED_INVALID_ENVELOPE",
    dispatchCount: 0,
    reused: false,
    dispatchId,
    idempotencyKey,
    rawRequestDigest: rawDigest,
    artifactDir: artifactRelative,
    stopPath,
    jobPath: jobRecord,
  };
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
    adapterEnvelope: options.adapterEnvelope ?? null,
    adapterEnvelopeSourceFile: options.adapterEnvelopeSourceFile ?? null,
    adapterEnvelopeSourceDigest: options.adapterEnvelopeSourceDigest ?? null,
    adapterEnvelopeSourceError: options.adapterEnvelopeSourceError ?? null,
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
    const dispatchId = options.dispatchId ?? crypto.randomUUID();
    const rawDigest = rawRequestDigest(options, { resultRelative, artifactRelative, jobRelative, capsuleRelative });
    const rawIdempotencyKey = text(options.idempotencyKey ?? `dd:raw:${rawDigest}`, "idempotencyKey");
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
        idempotencyKey: rawIdempotencyKey,
        dispatchIdentitySchema: null,
        dispatchIdentityHash: null,
        rawRequestDigest: rawDigest,
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
          idempotencyKey: rawIdempotencyKey,
          dispatchIdentitySchema: null,
          dispatchIdentityHash: null,
          rawRequestDigest: rawDigest,
          reason: previousJob?.__malformed || "existing artifact directory has no valid job record; reconciliation required",
          suspensionStatus: "unknown",
        };
      }
      const stopPath = `${artifactRelative}/adapter-envelope-stop.v1.json`;
      if (previousJob.state === "STOPPED_INVALID_ENVELOPE") {
        const conflicts = [];
        if (previousJob.rawRequestDigest !== rawDigest) conflicts.push("raw request digest does not match the preserved invalid-envelope stop");
        if (options.idempotencyKey && previousJob.idempotencyKey !== rawIdempotencyKey) conflicts.push("idempotency key does not match the preserved invalid-envelope stop");
        if (options.dispatchId && previousJob.dispatchId !== dispatchId) conflicts.push("dispatch ID does not match the preserved invalid-envelope stop");
        const previousStop = await readJsonIfPresent(root, stopPath);
        if (conflicts.length > 0) {
          return {
            schemaVersion: JOB_CONTROLLER_SCHEMA,
            status: "FAIL",
            dispatchCount: 0,
            dispatchId,
            idempotencyKey: rawIdempotencyKey,
            dispatchIdentitySchema: null,
            dispatchIdentityHash: null,
            rawRequestDigest: rawDigest,
            reason: conflicts.join("; "),
            artifactDir: artifactRelative,
            stopPath,
            suspensionStatus: "unknown",
          };
        }
        if (!previousStop || previousStop.__malformed) {
          return {
            schemaVersion: JOB_CONTROLLER_SCHEMA,
            status: "UNKNOWN",
            dispatchCount: 0,
            dispatchId: previousJob.dispatchId,
            idempotencyKey: previousJob.idempotencyKey,
            dispatchIdentitySchema: null,
            dispatchIdentityHash: null,
            rawRequestDigest: previousJob.rawRequestDigest ?? rawDigest,
            reason: previousStop?.__malformed || "invalid-envelope job has no valid stop record; reconciliation required",
            artifactDir: artifactRelative,
            stopPath,
            suspensionStatus: "unknown",
          };
        }
        return {
          ...previousStop,
          schemaVersion: JOB_CONTROLLER_SCHEMA,
          status: "STOPPED_INVALID_ENVELOPE",
          dispatchCount: 0,
          reused: true,
          dispatchId: previousJob.dispatchId,
          idempotencyKey: previousJob.idempotencyKey,
          dispatchIdentitySchema: null,
          dispatchIdentityHash: null,
          rawRequestDigest: previousJob.rawRequestDigest,
          artifactDir: artifactRelative,
          stopPath,
          jobPath: jobRelative,
        };
      }
      if (previousJob.dispatchIdentitySchema !== DISPATCH_IDENTITY_SCHEMA || !previousJob.adapterEnvelope?.normalizedDigest) {
        const status = previousJob.dispatchIdentitySchema === "dd.dispatch-identity.v1" || previousJob.state !== "DISPATCHING" ? "FAIL" : "UNKNOWN";
        return {
          schemaVersion: JOB_CONTROLLER_SCHEMA,
          status,
          dispatchCount: 0,
          dispatchId,
          idempotencyKey: rawIdempotencyKey,
          dispatchIdentitySchema: null,
          dispatchIdentityHash: null,
          rawRequestDigest: rawDigest,
          reason: "legacy dd.dispatch-identity.v1 job lacks adapter cwd identity and cannot be reused; no provider was launched",
          artifactDir: artifactRelative,
          suspensionStatus: "unknown",
        };
      }
      const existingEnvelope = await inspectAdapterEnvelope(root, options);
      if (!existingEnvelope.valid) {
        return {
          schemaVersion: JOB_CONTROLLER_SCHEMA,
          status: "FAIL",
          dispatchCount: 0,
          dispatchId,
          idempotencyKey: rawIdempotencyKey,
          dispatchIdentitySchema: null,
          dispatchIdentityHash: null,
          rawRequestDigest: rawDigest,
          reason: `current adapter envelope cannot reconcile the existing job: ${existingEnvelope.error}`,
          artifactDir: artifactRelative,
          suspensionStatus: "unknown",
        };
      }
      const existingIdentityHash = dispatchIdentityHash(options, {
        resultRelative,
        artifactRelative,
        jobRelative,
        capsuleRelative,
        adapterEnvelopeDigest: existingEnvelope.normalizedDigest,
      });
      const idempotencyKey = text(options.idempotencyKey ?? `dd:${existingIdentityHash}`, "idempotencyKey");
      const identityMismatches = [];
      if (previousJob.idempotencyKey !== idempotencyKey) identityMismatches.push("idempotency key does not match the persisted job record");
      if (previousJob.dispatchIdentityHash !== existingIdentityHash) identityMismatches.push("dispatch identity does not match the persisted job record");
      if (options.dispatchId && previousJob.dispatchId !== dispatchId) identityMismatches.push("dispatch ID does not match the persisted job record");
      if (identityMismatches.length > 0) {
        return {
          schemaVersion: JOB_CONTROLLER_SCHEMA,
          status: "FAIL",
          dispatchCount: 0,
          dispatchId,
          idempotencyKey,
          dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
          dispatchIdentityHash: existingIdentityHash,
          rawRequestDigest: rawDigest,
          reason: identityMismatches.join("; "),
          suspensionStatus: "unknown",
        };
      }
      const existing = await loadAndValidateCapsule(root, capsuleRelative, { expectedSession: options.expectedSession, verifyRaw: true });
      if (existing.valid) {
        const capsuleIdentityMismatches = [];
        if (existing.capsule.dispatchId !== previousJob.dispatchId) capsuleIdentityMismatches.push("capsule dispatchId does not match the persisted job");
        if (existing.capsule.idempotencyKey !== previousJob.idempotencyKey) capsuleIdentityMismatches.push("capsule idempotencyKey does not match the persisted job");
        if (existing.capsule.dispatchIdentitySchema !== DISPATCH_IDENTITY_SCHEMA || existing.capsule.dispatchIdentityHash !== previousJob.dispatchIdentityHash) capsuleIdentityMismatches.push("capsule dispatch identity does not match the persisted v2 job");
        if (existing.capsule.adapterEnvelopeDigest !== previousJob.adapterEnvelope.normalizedDigest) capsuleIdentityMismatches.push("capsule adapter envelope digest does not match the persisted job");
        if (capsuleIdentityMismatches.length > 0) {
          return {
            schemaVersion: JOB_CONTROLLER_SCHEMA,
            status: "FAIL",
            dispatchCount: 0,
            dispatchId,
            idempotencyKey,
            dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
            dispatchIdentityHash: existingIdentityHash,
            rawRequestDigest: rawDigest,
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
          dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
          dispatchIdentityHash: previousJob.dispatchIdentityHash,
          rawRequestDigest: rawDigest,
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
        dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
        dispatchIdentityHash: previousJob.dispatchIdentityHash,
        rawRequestDigest: rawDigest,
        reason: `existing job is not a verified terminal result: ${existing.errors.join("; ")}`,
        capsulePath: capsuleRelative,
        suspensionStatus: "unknown",
      };
    }

    const artifactDir = await createFreshDirectory(root, artifactRelative);
    const envelope = await inspectAdapterEnvelope(root, options);
    if (!envelope.valid) {
      const jobRecord = {
        schemaVersion: JOB_CONTROLLER_SCHEMA,
        dispatchId,
        idempotencyKey: rawIdempotencyKey,
        dispatchIdentitySchema: null,
        dispatchIdentityHash: null,
        rawRequestDigest: rawDigest,
        createdAt: now(),
        role: options.role,
        adapter: options.adapter,
        resultPath: resultRelative,
        artifactDir: artifactRelative,
        capsulePath: capsuleRelative,
        requestedSessionId: options.expectedSession,
        suspensionStatus: "unknown",
        adapterEnvelope: null,
        adapterEnvelopeValidation: { valid: false, code: envelope.code, reason: envelope.error },
        state: "STOPPED_INVALID_ENVELOPE",
      };
      await writeNewFile(root, jobRelative, `${JSON.stringify(jobRecord, null, 2)}\n`);
      const stopRecord = {
        schemaVersion: "dd.adapter-envelope-stop.v1",
        dispatchId,
        idempotencyKey: rawIdempotencyKey,
        dispatchIdentitySchema: null,
        dispatchIdentityHash: null,
        rawRequestDigest: rawDigest,
        createdAt: jobRecord.createdAt,
        status: "STOPPED_INVALID_ENVELOPE",
        reason: envelope.error,
        code: envelope.code,
        adapterEnvelope: null,
        capsulePath: null,
        providerLaunched: false,
        dispatchCount: 0,
      };
      const stopRelative = `${artifactRelative}/adapter-envelope-stop.v1.json`;
      await writeNewFile(root, stopRelative, `${JSON.stringify(stopRecord, null, 2)}\n`);
      return invalidEnvelopeResult({
        artifactRelative,
        stopPath: stopRelative,
        stopRecord,
        jobRecord: jobRelative,
        rawDigest,
        dispatchId,
        idempotencyKey: rawIdempotencyKey,
      });
    }
    const identityHash = dispatchIdentityHash(options, {
      resultRelative,
      artifactRelative,
      jobRelative,
      capsuleRelative,
      adapterEnvelopeDigest: envelope.normalizedDigest,
    });
    const idempotencyKey = text(options.idempotencyKey ?? `dd:${identityHash}`, "idempotencyKey");
    const jobRecord = {
      schemaVersion: JOB_CONTROLLER_SCHEMA,
      dispatchId,
      idempotencyKey,
      dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
      dispatchIdentityHash: identityHash,
      createdAt: now(),
      role: options.role,
      adapter: options.adapter,
      resultPath: resultRelative,
      artifactDir: artifactRelative,
      capsulePath: capsuleRelative,
      requestedSessionId: options.expectedSession,
      suspensionStatus: suspension.suspensionStatus,
      adapterEnvelope: envelope.record,
      adapterEnvelopeDigest: envelope.normalizedDigest,
      state: suspension.shouldStop ? "STOPPED_UNAVAILABLE" : "DISPATCHING",
    };
    await writeNewFile(root, jobRelative, `${JSON.stringify(jobRecord, null, 2)}\n`);

    if (suspension.shouldStop) {
      const stopRecord = {
        schemaVersion: "dd.suspension-stop.v1",
        dispatchId,
        idempotencyKey,
        dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
        dispatchIdentityHash: identityHash,
        createdAt: jobRecord.createdAt,
        status: "UNAVAILABLE",
        suspensionStatus: "unavailable",
        evidence: suspension.evidence,
        reason: "suspension is unavailable; no worker was dispatched and no model-polling fallback is permitted",
        capsulePath: null,
        adapterEnvelope: envelope.record,
      };
      const stopPath = `${artifactRelative}/suspension-stop.v1.json`;
      await writeNewFile(root, stopPath, `${JSON.stringify(stopRecord, null, 2)}\n`);
      return { ...stopRecord, dispatchCount: 0, artifactDir: artifactRelative, stopPath };
    }

    await ensureParent(root, resultRelative);
    const resultWatcher = await waitForResultEvent(root, resultRelative);
    const processResult = await runCapture(options.adapter, options.args, {
      cwd: absoluteFromRelative(root, envelope.envelope.effectiveWorkingDirectory),
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
    const transport = transportAssessment({
      process: {
        terminalStatus: processStatus,
        exitCode: processResult.code,
        spawnError: processResult.spawnError,
        timedOut: processResult.timedOut,
        logDrainTimedOut: processResult.logDrainTimedOut,
      },
      result: parsed ? { terminalStatus: resultStatus, exitCode: parsed.exitCode ?? null } : null,
      resultValidation: { valid: validation.valid, reason: validation.reason ?? resultError ?? null },
      requestedSessionId: options.expectedSession,
      observedSessionIds,
      sessionVerification,
    });
    const success = transport.succeeded;
    const roleStatus = capsuleRoleStatus(options.role, options.roleStatus ?? "NEEDS_EVIDENCE", transport);
    const rawArtifacts = [
      { kind: "adapter-stdout", locator: `${artifactRelative}/adapter.stdout.log` },
      { kind: "adapter-stderr", locator: `${artifactRelative}/adapter.stderr.log` },
    ];
    if (await existsRegular(root, resultRelative)) rawArtifacts.push({ kind: "provider-result", locator: resultRelative });
    const capsule = await emitResultCapsule(root, capsuleRelative, {
      dispatchId,
      idempotencyKey,
      dispatchIdentityHash: identityHash,
      dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
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
        spawnError: processResult.spawnError,
        timedOut: processResult.timedOut,
        logDrainTimedOut: processResult.logDrainTimedOut,
        processTreeTermination: processResult.processTreeTermination,
      },
      result: { terminalStatus: resultStatus, exitCode: parsed?.exitCode ?? processResult.code ?? null },
      resultValidation: { valid: validation.valid, reason: validation.reason ?? resultError ?? null, status: validation.status ?? null },
      transportStatus: success ? "SUCCEEDED" : "FAILED",
      transportFailureReasons: transport.failures,
      requestedSessionId: options.expectedSession,
      observedSessionIds,
      sessionVerification,
      suspensionStatus: suspension.suspensionStatus,
      suspensionEvidence: { ...suspension.evidence, resultObservedBeforeProcessExit: Boolean(resultObservedAt), resultWatch: resultWatcher.unavailable ? "unavailable" : "filesystem-event" },
      hostTelemetry: suspension.hostTelemetry,
      rawArtifacts,
      changedPaths: options.changedPaths,
      gateCoverage: options.gateCoverage ?? {},
      adapterEnvelope: envelope.record,
      adapterEnvelopeDigest: envelope.normalizedDigest,
      providerUsage: parsed?.usage,
      maxBytes: options.maxCapsuleBytes,
    });
    const failureReasons = transport.failures;
    return {
      schemaVersion: JOB_CONTROLLER_SCHEMA,
      status: success ? "PASS" : "FAIL",
      dispatchCount: 1,
      reused: false,
      dispatchId,
      idempotencyKey,
      dispatchIdentityHash: identityHash,
      dispatchIdentitySchema: DISPATCH_IDENTITY_SCHEMA,
      rawRequestDigest: rawDigest,
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
        spawnError: processResult.spawnError,
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
