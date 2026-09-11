import path from "node:path";
import {
  ABSOLUTE_CORRECTION_CEILING,
  TERMINAL_STATUSES,
  absoluteFromRelative,
  assertNoReparseCrossing,
  assertRelativeInput,
  boundedItems,
  fail,
  hashRegularFile,
  realDirectory,
  readOwnedFile,
  sha256Bytes,
  stableJson,
  writeNewFile,
} from "./lifecycle-core.mjs";

export const CAPSULE_SCHEMA = "dd.result-capsule.v1";
export const CAPSULE_DEFAULT_MAX_BYTES = 16 * 1024;
const PROVIDER_USAGE_MAX_BYTES = 2048;
export const SUSPENSION_STATUSES = new Set(["enforced", "unavailable", "unknown"]);
export const SESSION_VERIFICATIONS = new Set(["matched", "mismatch", "not_requested", "unknown"]);
const CHANGED_PATH_STATUSES = new Set(["complete", "incomplete", "unknown"]);
export const ROLE_STATUS_VOCABULARY = Object.freeze({
  executor: new Set(["READY_FOR_VERIFICATION", "FAILED"]),
  planner: new Set(["APPROVE", "BLOCK", "NEEDS_EVIDENCE", "TRANSPORT_FAILED"]),
  mechanical: new Set(["PASS", "FAIL", "UNKNOWN"]),
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`, "E_CAPSULE_FIELD");
  return value;
}

function iso(value, label) {
  const candidate = value ?? new Date().toISOString();
  if (typeof candidate !== "string" || Number.isNaN(Date.parse(candidate))) fail(`${label} must be an ISO-8601 timestamp`, "E_CAPSULE_FIELD");
  return candidate;
}

function normalizedRole(role) {
  const value = String(role || "executor").toLowerCase();
  if (!ROLE_STATUS_VOCABULARY[value]) fail(`unsupported capsule role: ${role}`, "E_CAPSULE_ROLE");
  return value;
}

function transportAssessment(options, process, result, resultValidation, requestedSessionId, sessionVerification) {
  const failures = [];
  if (!process || process.spawnError) failures.push("adapter spawn failed");
  if (process?.timedOut) failures.push("adapter timeout");
  if (process?.logDrainTimedOut) failures.push("log drain timed out");
  if (process?.terminalStatus !== "completed") failures.push(`adapter process status ${process?.terminalStatus ?? "unknown"}`);
  if (process?.exitCode !== 0) failures.push(`adapter exit code ${process?.exitCode ?? "unknown"}`);
  if ((options.terminal ?? true) !== true) failures.push("terminal result was not marked terminal");
  if (!result) failures.push("missing terminal result");
  if (resultValidation && resultValidation.valid !== true) failures.push(resultValidation.reason || "invalid terminal result");
  if (result && String(result.terminalStatus ?? "").toLowerCase() !== "completed") failures.push(`provider result status ${result.terminalStatus ?? "unknown"}`);
  if (result && result.exitCode !== null && result.exitCode !== undefined && result.exitCode !== 0) failures.push(`provider result exit code ${result.exitCode}`);
  if (requestedSessionId !== null && sessionVerification !== "matched") failures.push(`expected session ${requestedSessionId} was not matched`);
  return { succeeded: failures.length === 0, failures };
}

function normalizedStatus(role, status, process, transport) {
  if (status !== undefined && status !== null) {
    const value = String(status).toUpperCase();
    if (!ROLE_STATUS_VOCABULARY[role].has(value)) fail(`invalid ${role} role status: ${status}`, "E_CAPSULE_STATUS");
    if (role === "planner" && transport.succeeded && value === "TRANSPORT_FAILED") fail("TRANSPORT_FAILED is invalid for a mechanically successful transport", "E_CAPSULE_STATUS");
    if (role === "planner" && !transport.succeeded && value !== "TRANSPORT_FAILED") fail("mechanically failed planner transport requires TRANSPORT_FAILED", "E_CAPSULE_STATUS");
    if (role !== "planner" && value === "TRANSPORT_FAILED") fail("TRANSPORT_FAILED is reserved for planner capsules", "E_CAPSULE_STATUS");
    if (role === "executor" && transport.succeeded && value === "FAILED") fail("successful executor transport cannot emit FAILED", "E_CAPSULE_STATUS");
    if (role === "executor" && !transport.succeeded && value === "READY_FOR_VERIFICATION") fail("failed executor transport cannot emit READY_FOR_VERIFICATION", "E_CAPSULE_STATUS");
    if (role === "mechanical" && transport.succeeded && value === "FAIL") fail("successful mechanical transport cannot emit FAIL", "E_CAPSULE_STATUS");
    if (role === "mechanical" && !transport.succeeded && value === "PASS") fail("failed mechanical transport cannot emit PASS", "E_CAPSULE_STATUS");
    return value;
  }
  if (role === "mechanical") return transport.succeeded ? "PASS" : "FAIL";
  if (role === "executor") return transport.succeeded ? "READY_FOR_VERIFICATION" : "FAILED";
  return transport.succeeded ? "NEEDS_EVIDENCE" : "TRANSPORT_FAILED";
}

function normalizedSuspension(status, evidence, hostTelemetry) {
  const value = status ?? "unknown";
  if (!SUSPENSION_STATUSES.has(value)) fail(`invalid suspensionStatus: ${value}`, "E_SUSPENSION_STATUS");
  const telemetry = hostTelemetry || evidence?.hostTelemetry;
  if (value === "enforced" && telemetry?.leadModelTurnsBetweenDispatchAndTerminal !== 0) {
    fail("suspensionStatus=enforced requires explicit host telemetry proving zero Lead model turns", "E_SUSPENSION_EVIDENCE");
  }
  if (value === "enforced") fail("current controller cannot emit enforced suspension; legacy raw capsules are validation-only", "E_SUSPENSION_EMISSION");
  if (value === "unavailable" && evidence === undefined) {
    fail("suspensionStatus=unavailable requires an evidence basis", "E_SUSPENSION_EVIDENCE");
  }
  return {
    status: value,
    evidence: clone(evidence) ?? { basis: "host suspension telemetry was not supplied; awaitable wait is not proof of enforcement" },
    hostTelemetry: clone(telemetry) ?? null,
  };
}

function normalizedRawLocator(value, fallback) {
  if (value !== undefined && value !== null && fallback !== undefined && fallback !== null && value !== fallback) {
    fail("changed-path raw locator declarations contradict each other", "E_CHANGED_PATHS");
  }
  const candidate = value ?? fallback ?? null;
  if (candidate === null) return null;
  if (typeof candidate !== "string" || candidate.length === 0) fail("changed-path raw locator must be a non-empty project-relative path", "E_CHANGED_PATHS");
  return assertRelativeInput(candidate, "changed-path raw locator");
}

function normalizedChangedPaths(value, fallbackRawLocator) {
  if (value === undefined) {
    if (fallbackRawLocator !== undefined && fallbackRawLocator !== null) fail("omitted changed-path evidence cannot have a raw locator", "E_CHANGED_PATHS");
    return { items: [], omittedCount: 0, status: "unknown", complete: null, rawLocator: null };
  }
  const holder = Array.isArray(value) ? { items: value } : value;
  if (!holder || typeof holder !== "object" || !Array.isArray(holder.items)) fail("changedPaths must be an array or an object with an items array", "E_CHANGED_PATHS");
  const rawLocator = normalizedRawLocator(holder.rawLocator, fallbackRawLocator);
  const declaredStatus = holder.status;
  if (declaredStatus !== undefined && !CHANGED_PATH_STATUSES.has(declaredStatus)) fail(`invalid changed-path status: ${declaredStatus}`, "E_CHANGED_PATHS");
  if (holder.complete !== undefined && typeof holder.complete !== "boolean") fail("changedPaths.complete must be boolean when supplied", "E_CHANGED_PATHS");
  if (holder.truncated !== undefined && typeof holder.truncated !== "boolean") fail("changedPaths.truncated must be boolean when supplied", "E_CHANGED_PATHS");
  if (holder.omittedCount !== undefined && (!Number.isInteger(holder.omittedCount) || holder.omittedCount < 0)) fail("changedPaths.omittedCount must be a non-negative integer", "E_CHANGED_PATHS");
  const bounded = boundedItems(holder.items, rawLocator, 32, 3500);
  const omittedCount = Math.max(bounded.omittedCount, holder.omittedCount ?? 0);
  const partialDeclared = holder.complete === false || holder.truncated === true || omittedCount > 0;
  let status = declaredStatus;
  if (status === undefined) status = partialDeclared ? "incomplete" : "complete";
  if (status === "unknown") fail("explicit changed-path evidence cannot be marked unknown; omit the field instead", "E_CHANGED_PATHS");
  if (status === "complete" && (holder.complete === false || holder.truncated === true || omittedCount > 0)) fail("complete changed-path evidence contradicts partial or omitted items", "E_CHANGED_PATHS");
  if (status === "incomplete" && rawLocator === null) fail("partial or truncated changed-path evidence requires a raw locator", "E_CHANGED_PATHS");
  if (status === "incomplete" && holder.complete === true) fail("changedPaths.complete=true contradicts incomplete status", "E_CHANGED_PATHS");
  if (status === "complete" && holder.complete === false) fail("changedPaths.complete=false contradicts complete status", "E_CHANGED_PATHS");
  if (status === "complete" && bounded.omittedCount > 0) fail("bounded changed-path evidence requires incomplete status and a raw locator", "E_CHANGED_PATHS");
  return {
    items: bounded.items,
    omittedCount,
    status,
    complete: status === "complete" ? true : false,
    ...(rawLocator !== null ? { rawLocator } : {}),
  };
}

function normalizedAdapterEnvelope(value, expectedDigest) {
  if (value === undefined || value === null) {
    if (expectedDigest !== undefined && expectedDigest !== null) fail("adapterEnvelopeDigest requires adapter envelope metadata", "E_ADAPTER_ENVELOPE");
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("adapterEnvelope must be an object", "E_ADAPTER_ENVELOPE");
  if (value.schemaVersion !== "dd.adapter-envelope.v1") fail("adapterEnvelope schemaVersion is invalid", "E_ADAPTER_ENVELOPE");
  const effectiveWorkingDirectory = assertRelativeInput(value.effectiveWorkingDirectory, "adapter envelope effectiveWorkingDirectory");
  if (value.cwdMode !== "inherits_process" && value.cwdMode !== "adapter_contract") fail("adapterEnvelope cwdMode is invalid", "E_ADAPTER_ENVELOPE");
  if (value.cwdMode === "inherits_process" && value.adapterContract !== null) fail("inherits_process adapterEnvelope requires adapterContract=null", "E_ADAPTER_ENVELOPE");
  if (value.cwdMode === "adapter_contract" && (!value.adapterContract || typeof value.adapterContract !== "object" || Array.isArray(value.adapterContract))) fail("adapter_contract adapterEnvelope requires adapterContract metadata", "E_ADAPTER_ENVELOPE");
  const base = {
    schemaVersion: "dd.adapter-envelope.v1",
    effectiveWorkingDirectory,
    cwdMode: value.cwdMode,
    adapterContract: value.adapterContract === null ? null : {
      adapter: requireText(value.adapterContract.adapter, "adapterContract adapter"),
      cwdArgument: requireText(value.adapterContract.cwdArgument, "adapterContract cwdArgument"),
      cwdValue: assertRelativeInput(value.adapterContract.cwdValue, "adapterContract cwdValue"),
    },
  };
  const digest = value.normalizedDigest ?? value.canonicalDigest ?? value.digest ?? expectedDigest ?? null;
  if (!/^[a-f0-9]{64}$/i.test(String(digest || ""))) fail("adapterEnvelope normalized digest is invalid", "E_ADAPTER_ENVELOPE");
  if (expectedDigest !== undefined && expectedDigest !== null && digest !== expectedDigest) fail("adapterEnvelopeDigest does not match adapter envelope metadata", "E_ADAPTER_ENVELOPE");
  const computed = sha256Bytes(stableJson(base));
  if (computed !== digest) fail("adapterEnvelope normalized digest does not match metadata", "E_ADAPTER_ENVELOPE");
  const sourceFile = value.sourceFile ?? null;
  if (sourceFile !== null) assertRelativeInput(sourceFile, "adapter envelope source file");
  const sourceFileDigest = value.sourceFileDigest ?? null;
  if (sourceFileDigest !== null && !/^[a-f0-9]{64}$/i.test(String(sourceFileDigest))) fail("adapterEnvelope source-file digest is invalid", "E_ADAPTER_ENVELOPE");
  return {
    ...base,
    normalizedDigest: digest,
    canonicalDigest: digest,
    sourceFile,
    sourceFileDigest,
    evidence: value.evidence ?? "declaration",
    limitation: value.limitation ?? "declaration/contract evidence only; argv and adapter cwd behavior are not OS attestation",
  };
}

function normalizedList(value, rawLocator, maxItems, maxChars) {
  if (Array.isArray(value)) return boundedItems(value, rawLocator, maxItems, maxChars);
  if (value && Array.isArray(value.items)) {
    const bounded = boundedItems(value.items, value.rawLocator || rawLocator, maxItems, maxChars);
    if (Number.isInteger(value.omittedCount) && value.omittedCount > bounded.omittedCount) {
      bounded.omittedCount = value.omittedCount;
      if (value.rawLocator || rawLocator) bounded.rawLocator = value.rawLocator || rawLocator;
    }
    return bounded;
  }
  return boundedItems([], rawLocator, maxItems, maxChars);
}

function assertSessionVerification(requestedSessionId, observedSessionIds, sessionVerification) {
  if (sessionVerification === "not_requested" && requestedSessionId !== null) {
    fail("sessionVerification=not_requested requires no requested session ID", "E_CAPSULE_SESSION");
  }
  if (sessionVerification === "matched" && (
    requestedSessionId === null ||
    observedSessionIds.length === 0 ||
    !observedSessionIds.includes(requestedSessionId)
  )) {
    fail("sessionVerification=matched requires a requested session ID present in observed IDs", "E_CAPSULE_SESSION");
  }
}

function prepareProviderUsage(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { omitted: true, reason: "providerUsage is not JSON-serializable" };
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > PROVIDER_USAGE_MAX_BYTES) {
    return { omitted: true, reason: "providerUsage exceeded its capsule bound" };
  }
  return { value: JSON.parse(serialized) };
}

function normalizeRawArtifact(item) {
  if (typeof item === "string") return { kind: "evidence", locator: assertRelativeInput(item, "raw artifact locator") };
  if (!item || typeof item !== "object") fail("raw artifact must be a locator or object", "E_CAPSULE_ARTIFACT");
  return {
    kind: typeof item.kind === "string" && item.kind ? item.kind : "evidence",
    locator: assertRelativeInput(item.locator, "raw artifact locator"),
  };
}

function ensureUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} contains a duplicate: ${value}`, "E_CAPSULE_ARTIFACT");
    seen.add(value);
  }
}

function fitCapsule(capsule, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 512) fail("capsule byte limit must be an integer >= 512", "E_CAPSULE_LIMIT");
  const bytes = () => Buffer.byteLength(`${JSON.stringify(capsule)}\n`, "utf8");
  if (bytes() <= maxBytes) return { capsule, text: JSON.stringify(capsule) };

  capsule.truncation.capsule = true;
  const trim = (collection, keep, countKey) => {
    if (!collection?.items || collection.items.length <= keep) return;
    if (countKey === "changedPaths" && !collection.rawLocator) {
      fail("truncated changed-path evidence requires a raw locator", "E_CHANGED_PATHS");
    }
    const omitted = collection.items.length - keep;
    collection.items = collection.items.slice(0, keep);
    collection.omittedCount += omitted;
    capsule.omittedItemCounts[countKey] = (capsule.omittedItemCounts[countKey] || 0) + omitted;
    capsule.truncation[countKey] = true;
    if (countKey === "changedPaths") {
      collection.status = "incomplete";
      collection.complete = false;
    }
  };
  const trimCollections = (keep) => {
    trim(capsule.changedPaths, keep, "changedPaths");
    trim(capsule.gateCoverage?.checks, keep, "gateCoverage");
  };
  trimCollections(8);
  if (typeof capsule.suspensionEvidence === "string" && capsule.suspensionEvidence.length > 512) {
    capsule.suspensionEvidence = `${capsule.suspensionEvidence.slice(0, 509)}...`;
  }
  if (Object.prototype.hasOwnProperty.call(capsule, "providerUsage")) {
    delete capsule.providerUsage;
    capsule.truncation.providerUsage = true;
    capsule.truncation.providerUsageReason = "capsule byte limit";
    capsule.omittedItemCounts.providerUsage = (capsule.omittedItemCounts.providerUsage || 0) + 1;
  }
  let text = JSON.stringify(capsule);
  if (Buffer.byteLength(`${text}\n`, "utf8") <= maxBytes) return { capsule, text };

  trimCollections(2);
  text = JSON.stringify(capsule);
  if (Buffer.byteLength(`${text}\n`, "utf8") <= maxBytes) return { capsule, text };

  trimCollections(0);
  text = JSON.stringify(capsule);
  if (Buffer.byteLength(`${text}\n`, "utf8") <= maxBytes) return { capsule, text };

  // Raw artifact locators and digests are never discarded.  If a caller asks
  // for an unrealistically small capsule, fail closed instead of omitting
  // integrity evidence.
  fail("result capsule cannot fit the requested byte limit without dropping raw integrity evidence", "E_CAPSULE_LIMIT");
}

export async function createResultCapsule(options = {}) {
  const root = await realDirectory(options.root, "root");
  const role = normalizedRole(options.role);
  const process = {
    terminalStatus: String(options.process?.terminalStatus ?? options.processStatus ?? "unknown").toLowerCase(),
    exitCode: options.process?.exitCode ?? options.processExitCode ?? null,
    signal: options.process?.signal ?? null,
    spawnError: clone(options.process?.spawnError) ?? null,
    timedOut: Boolean(options.process?.timedOut),
    logDrainTimedOut: Boolean(options.process?.logDrainTimedOut),
    processTreeTermination: options.process?.processTreeTermination ?? "unknown",
  };
  const resultStatus = options.result?.terminalStatus ?? options.resultStatus ?? null;
  const resultExitCode = options.result?.exitCode ?? options.resultExitCode ?? null;
  const terminal = options.terminal ?? true;
  const capsuleStatus = options.capsuleStatus ?? (terminal ? "TERMINAL" : "UNKNOWN");
  const dispatchId = requireText(options.dispatchId, "dispatchId");
  const idempotencyKey = requireText(options.idempotencyKey, "idempotencyKey");
  const dispatchIdentityHash = options.dispatchIdentityHash ?? null;
  if (dispatchIdentityHash !== null && !/^[a-f0-9]{64}$/i.test(dispatchIdentityHash)) fail("dispatchIdentityHash must be a SHA-256 hex digest", "E_CAPSULE_FIELD");
  const createdAt = iso(options.createdAt, "createdAt");
  const completedAt = iso(options.completedAt, "completedAt");
  if (Date.parse(completedAt) < Date.parse(createdAt)) fail("completedAt must not precede createdAt", "E_CAPSULE_FIELD");
  const suspension = normalizedSuspension(options.suspensionStatus, options.suspensionEvidence, options.hostTelemetry);
  const requestedSessionId = options.requestedSessionId ?? null;
  if (requestedSessionId !== null && typeof requestedSessionId !== "string") fail("requestedSessionId must be a string or null", "E_CAPSULE_SESSION");
  const observedSessionIds = [...new Set((options.observedSessionIds || []).filter((value) => typeof value === "string" && value.length > 0))];
  const sessionVerification = options.sessionVerification ?? (requestedSessionId === null ? "not_requested" : observedSessionIds.includes(requestedSessionId) ? "matched" : "mismatch");
  if (!SESSION_VERIFICATIONS.has(sessionVerification)) fail(`invalid sessionVerification: ${sessionVerification}`, "E_CAPSULE_SESSION");
  assertSessionVerification(requestedSessionId, observedSessionIds, sessionVerification);
  const transport = transportAssessment(options, process, resultStatus === null ? null : { terminalStatus: resultStatus, exitCode: resultExitCode }, options.resultValidation, requestedSessionId, sessionVerification);
  const roleStatus = normalizedStatus(role, options.roleStatus, process, transport);

  const rawArtifacts = (options.rawArtifacts || []).map(normalizeRawArtifact);
  if (rawArtifacts.length === 0) fail("at least one raw artifact locator is required", "E_CAPSULE_ARTIFACT");
  ensureUnique(rawArtifacts.map((item) => item.locator), "raw artifact locators");
  const artifactEvidence = [];
  for (const artifact of rawArtifacts) {
    await assertNoReparseCrossing(root, artifact.locator, { allowMissing: false, includeFinal: true });
    const absolute = absoluteFromRelative(root, artifact.locator);
    const hashed = await hashRegularFile(absolute);
    artifactEvidence.push({ ...artifact, sha256: hashed.digest, bytes: hashed.size });
  }

  const changedPaths = normalizedChangedPaths(options.changedPaths, options.changedPathsRawLocator);
  const adapterEnvelope = normalizedAdapterEnvelope(options.adapterEnvelope, options.adapterEnvelopeDigest);
  const gateInput = options.gateCoverage ?? {};
  const gateChecks = normalizedList(gateInput.checks ?? gateInput.items ?? [], gateInput.rawLocator, 32, 3500);
  if (gateInput.complete === true && gateChecks.items.length === 0) {
    fail("gateCoverage.complete cannot be true with an empty checks list", "E_GATE_COVERAGE");
  }
  const gateComplete = gateInput.complete === true && gateChecks.items.length > 0;
  const gateCoverageStatus = gateInput.complete === false
    ? "incomplete"
    : gateComplete ? "complete" : "unknown";
  const capsule = {
    schemaVersion: CAPSULE_SCHEMA,
    capsuleVersion: 1,
    dispatchId,
    idempotencyKey,
    dispatchIdentitySchema: options.dispatchIdentitySchema ?? null,
    dispatchIdentityHash,
    createdAt,
    completedAt,
    role,
    adapter: requireText(options.adapter ?? "unknown", "adapter"),
    status: roleStatus,
    roleStatus,
    capsuleStatus,
    terminal: Boolean(terminal),
    processStatus: process.terminalStatus,
    processExitCode: process.exitCode,
    process,
    resultStatus,
    resultExitCode,
    result: { terminal: Boolean(terminal), status: resultStatus, exitCode: resultExitCode },
    resultValidation: clone(options.resultValidation) ?? null,
    transportStatus: transport.succeeded ? "SUCCEEDED" : "FAILED",
    transportFailureReasons: transport.failures,
    requestedSessionId,
    observedSessionIds,
    sessionVerification,
    suspensionStatus: suspension.status,
    suspensionEvidence: suspension.evidence,
    hostTelemetry: suspension.hostTelemetry,
    adapterEnvelope,
    adapterEnvelopeDigest: adapterEnvelope?.normalizedDigest ?? null,
    rawArtifacts: artifactEvidence,
    rawLocators: [...new Set([
      ...artifactEvidence.map((item) => item.locator),
      ...(changedPaths.rawLocator ? [changedPaths.rawLocator] : []),
      ...(gateChecks.rawLocator ? [gateChecks.rawLocator] : []),
      ...(gateInput.rawLocator ? [gateInput.rawLocator] : []),
    ])],
    changedPaths,
    gateCoverage: {
      checks: gateChecks,
      complete: gateComplete,
      status: gateCoverageStatus,
      rawLocator: gateInput.rawLocator ?? null,
    },
    truncation: {
      capsule: false,
      rawLogs: process.logDrainTimedOut,
      rawResult: false,
      changedPaths: changedPaths.omittedCount > 0,
      gateCoverage: gateChecks.omittedCount > 0,
      providerUsage: false,
    },
    omittedItemCounts: {
      changedPaths: changedPaths.omittedCount,
      gateCoverage: gateChecks.omittedCount,
      rawArtifacts: 0,
      providerUsage: 0,
    },
    coverageLimits: [
      "SHA-256 is an integrity check only when the expected digest is trusted; it is not a signature, identity proof, or provenance proof.",
      "Process-tree coverage is reported by the owned-process implementation and is not inferred from child exit alone.",
    ],
    integrity: { digestAlgorithm: "sha256", meaning: "integrity_only", signature: false },
  };
  if (options.providerUsage !== undefined && options.providerUsage !== null) {
    const providerUsage = prepareProviderUsage(options.providerUsage);
    if (providerUsage.omitted) {
      capsule.truncation.providerUsage = true;
      capsule.truncation.providerUsageReason = providerUsage.reason;
      capsule.omittedItemCounts.providerUsage = 1;
    } else {
      capsule.providerUsage = providerUsage.value;
    }
  }
  const bounded = fitCapsule(capsule, options.maxBytes ?? CAPSULE_DEFAULT_MAX_BYTES);
  return { capsule: bounded.capsule, text: `${bounded.text}\n` };
}

export async function emitResultCapsule(root, relative, options = {}) {
  const capsuleRelative = assertRelativeInput(relative, "capsule output");
  const created = await createResultCapsule({ ...options, root });
  await writeNewFile(root, capsuleRelative, created.text);
  return { ...created, capsulePath: capsuleRelative };
}

function changedPathValidationErrors(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.items)) {
    return ["changedPaths evidence is missing or malformed"];
  }
  const omittedCount = value.omittedCount;
  if (!Number.isInteger(omittedCount) || omittedCount < 0) errors.push("changedPaths.omittedCount is invalid");
  const rawLocator = value.rawLocator ?? null;
  if (rawLocator !== null) {
    try { assertRelativeInput(rawLocator, "changedPaths raw locator"); } catch (error) { errors.push(error.message); }
  }
  const inferredStatus = (omittedCount > 0 || rawLocator !== null && value.complete === false) ? "incomplete" : value.items.length === 0 && value.complete === null ? "unknown" : "complete";
  const status = value.status ?? inferredStatus;
  if (!CHANGED_PATH_STATUSES.has(status)) errors.push("changedPaths.status is invalid");
  if (value.complete !== undefined && value.complete !== null && typeof value.complete !== "boolean") errors.push("changedPaths.complete is invalid");
  if (status === "unknown" && (value.items.length > 0 || omittedCount !== 0 || rawLocator !== null || value.complete !== null && value.complete !== undefined)) errors.push("unknown changed-path coverage contradicts collected evidence");
  if (status === "complete" && (omittedCount > 0 || value.complete === false)) errors.push("complete changed-path coverage contradicts omission or completeness");
  if (status === "incomplete" && rawLocator === null) errors.push("incomplete changed-path coverage requires a raw locator");
  if (status === "incomplete" && value.complete === true) errors.push("incomplete changed-path coverage contradicts complete=true");
  if (status === "complete" && value.complete === false) errors.push("complete changed-path coverage contradicts complete=false");
  if (status === "unknown" && value.complete === true) errors.push("unknown changed-path coverage contradicts complete=true");
  return errors;
}

export async function validateResultCapsule(value, options = {}) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["capsule is not an object"] };
  if (value.schemaVersion !== CAPSULE_SCHEMA) errors.push("schemaVersion is invalid");
  if (!Number.isInteger(value.capsuleVersion) || value.capsuleVersion !== 1) errors.push("capsuleVersion is invalid");
  if (typeof value.dispatchId !== "string" || value.dispatchId.length === 0) errors.push("dispatchId is missing");
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length === 0) errors.push("idempotencyKey is missing");
  if (value.dispatchIdentitySchema !== undefined && value.dispatchIdentitySchema !== null && value.dispatchIdentitySchema !== "dd.dispatch-identity.v2") errors.push("dispatchIdentitySchema is invalid");
  if (!ROLE_STATUS_VOCABULARY[value.role] || !ROLE_STATUS_VOCABULARY[value.role].has(value.roleStatus) || value.status !== value.roleStatus) errors.push("role-scoped status is invalid");
  if (value.transportStatus !== undefined && value.transportStatus !== null && !new Set(["SUCCEEDED", "FAILED"]).has(value.transportStatus)) errors.push("transportStatus is invalid");
  if (value.transportStatus === "SUCCEEDED" && value.role === "planner" && value.roleStatus === "TRANSPORT_FAILED") errors.push("successful planner transport cannot be TRANSPORT_FAILED");
  if (value.transportStatus === "FAILED" && value.role === "planner" && value.roleStatus !== "TRANSPORT_FAILED") errors.push("failed planner transport must be TRANSPORT_FAILED");
  try {
    const envelope = normalizedAdapterEnvelope(value.adapterEnvelope, value.adapterEnvelopeDigest);
    if (envelope && value.adapterEnvelopeDigest !== envelope.normalizedDigest) errors.push("adapterEnvelopeDigest is inconsistent");
  } catch (error) {
    errors.push(error.message);
  }
  if (!SUSPENSION_STATUSES.has(value.suspensionStatus)) errors.push("suspensionStatus is invalid");
  if (!SESSION_VERIFICATIONS.has(value.sessionVerification)) errors.push("sessionVerification is invalid");
  if (value.suspensionStatus === "enforced" && value.hostTelemetry?.leadModelTurnsBetweenDispatchAndTerminal !== 0) errors.push("enforced suspension lacks zero-turn host telemetry");
  const requestedSessionId = value.requestedSessionId ?? null;
  const observedSessionIds = Array.isArray(value.observedSessionIds)
    ? value.observedSessionIds.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  if (value.sessionVerification === "not_requested" && requestedSessionId !== null) errors.push("not_requested session verification has a requested session ID");
  if (value.sessionVerification === "matched" && (
    requestedSessionId === null ||
    observedSessionIds.length === 0 ||
    !observedSessionIds.includes(requestedSessionId)
  )) errors.push("matched session verification lacks a requested ID in observed IDs");
  const isUnavailable = value.capsuleStatus === "STOPPED_UNAVAILABLE" && value.suspensionStatus === "unavailable";
  if (!isUnavailable && value.terminal !== true) errors.push("terminal capsule is not terminal");
  if (!isUnavailable && (!TERMINAL_STATUSES.has(String(value.processStatus || "").toLowerCase()) || !TERMINAL_STATUSES.has(String(value.resultStatus || "").toLowerCase()))) {
    errors.push("process/result status is nonterminal or unknown");
  }
  const created = Date.parse(value.createdAt);
  const completed = Date.parse(value.completedAt);
  if (Number.isNaN(created) || Number.isNaN(completed) || completed < created) errors.push("capsule timestamps are invalid");
  if (options.notBefore && !Number.isNaN(created) && created < Date.parse(options.notBefore)) errors.push("stale capsule predates notBefore");
  if (options.expectedSession !== undefined && options.expectedSession !== null) {
    if (value.requestedSessionId !== options.expectedSession || !value.observedSessionIds?.includes(options.expectedSession) || value.sessionVerification !== "matched") errors.push("session mismatch");
  }
  if (!value.gateCoverage || typeof value.gateCoverage !== "object" || !value.gateCoverage.checks || !Array.isArray(value.gateCoverage.checks.items)) {
    errors.push("gateCoverage checks are missing");
  } else if (value.gateCoverage.complete === true && value.gateCoverage.checks.items.length === 0) {
    errors.push("gateCoverage.complete cannot be true with an empty checks list");
  }
  errors.push(...changedPathValidationErrors(value.changedPaths));
  if (!Array.isArray(value.rawArtifacts) || value.rawArtifacts.length === 0) errors.push("rawArtifacts are missing");
  else {
    const locators = new Set();
    for (const artifact of value.rawArtifacts) {
      if (!artifact || typeof artifact !== "object") {
        errors.push("raw artifact entry is invalid");
        continue;
      }
      if (typeof artifact.locator !== "string" || !/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ""))) errors.push("raw artifact locator or sha256 is invalid");
      if (typeof artifact.locator === "string" && locators.has(artifact.locator)) errors.push("raw artifact locator is duplicated");
      if (typeof artifact.locator === "string") locators.add(artifact.locator);
      if (options.root && options.verifyRaw !== false && typeof artifact.locator === "string") {
        try {
          await assertNoReparseCrossing(await realDirectory(options.root, "root"), artifact.locator, { allowMissing: false, includeFinal: true });
          const hashed = await hashRegularFile(absoluteFromRelative(await realDirectory(options.root, "root"), artifact.locator));
          if (hashed.digest !== artifact.sha256) errors.push(`digest mismatch: ${artifact.locator}`);
        } catch (error) {
          errors.push(`raw artifact unavailable: ${artifact.locator}: ${error.message}`);
        }
      }
    }
  }
  const suspensionAttestation = value.suspensionStatus === "enforced" ? "non-attested" : "not_applicable";
  return { valid: errors.length === 0, errors, capsule: value, attestation: suspensionAttestation, suspensionAttestation };
}

export async function loadAndValidateCapsule(root, relative, options = {}) {
  const capsuleRelative = assertRelativeInput(relative, "capsule path");
  let value;
  try {
    value = JSON.parse((await readOwnedFile(root, capsuleRelative, "capsule")).toString("utf8"));
  } catch (error) {
    return { valid: false, errors: [`malformed capsule: ${error.message}`] };
  }
  return validateResultCapsule(value, { ...options, root });
}

export function capsuleRawPath(capsule, kind) {
  return capsule.rawArtifacts?.find((item) => item.kind === kind)?.locator ?? null;
}

// Public vocabulary for callers that want to validate a role before emitting.
export function roleStatuses(role) {
  const normalized = normalizedRole(role);
  return [...ROLE_STATUS_VOCABULARY[normalized]];
}

export { ABSOLUTE_CORRECTION_CEILING };
