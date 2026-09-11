#!/usr/bin/env node

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  absoluteFromRelative,
  assertNoReparseCrossing,
  assertRelativeInput,
  ensureParent,
  extractSessionRefs,
  readOwnedFile,
  realDirectory,
  stableJson,
  validateResultArtifact,
} from "./lib/lifecycle-core.mjs";
import { dispatchProcessJob } from "./lib/job-controller.mjs";
import { loadAndValidateCapsule } from "./lib/result-capsule.mjs";
import {
  captureUsage,
  ensureUsageLedger,
  readUsageLedger,
  resolveUsageSource,
  usageSourcePrefixMatches,
} from "./dd-usage.mjs";

export const BOOTSTRAP_SCHEMA = "dd.planner2-bootstrap.v1";
export const LEAD_BOUNDARY_NAMESPACE = "dd-planner2-bootstrap-lead-boundary.v1";
export const LEAD_BOUNDARY_LIMITATION =
  "This boundary was captured before the command returned; it may not include the assistant's later user-facing confirmation message and is not a complete post-human-seeing turn.";

const CAPSULE_ROLE = "planner";
const CAPSULE_STATUS = "NEEDS_EVIDENCE";
const MAX_CONFIRMATION_BYTES = 8192;
const SECRET_SHAPED = /(sk-[A-Za-z0-9]|gh[pousr]_[A-Za-z0-9]|AKIA[0-9A-Z]{16}|-----BEGIN|bearer\s+|api[_-]?key)/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const CONTEXT_STRING_FIELDS = [
  "provider",
  "role",
  "requiredMode",
  "requestedSetting",
  "capability",
  "effectiveSettingEvidence",
  "preflightStatus",
  "observedOccupancy",
];

class BootstrapError extends Error {
  constructor(message, code = "E_BOOTSTRAP", details = {}) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = "E_BOOTSTRAP", details = {}) {
  throw new BootstrapError(message, code, details);
}

function usage() {
  return `Deterministic Deliberate Delegate Planner 2 bootstrap

Usage:
  node dd-bootstrap.mjs --root <project> --ledger <relative-jsonl>
    --experiment-id <id> --lead-rollout <exact-rollout-source>
    --adapter <executable> --args-file <relative-json-array>
    --result <relative-result-json> --artifact-dir <relative-stable-dir>
    --planner2-source <relative-relay-dir-or-source>
    --confirmation <relative-json> --timeout-ms <integer>
    --suspension-available <true|false>
    [--context-evidence-file <relative-json>]
    [--host-telemetry-file <relative-json>]

The adapter, argv, provider result, relay source, and paths are caller-owned
inputs. The command selects no provider, model, prompt, budget, permissions,
or session policy and returns once at the human approval boundary.`;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { help: true };
  }
  if (argv[0] === "run") argv = argv.slice(1);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    return { help: true };
  }
  const aliases = new Map([
    ["root", "root"],
    ["ledger", "ledger"],
    ["experiment-id", "experimentId"],
    ["lead-rollout", "leadRollout"],
    ["lead-source", "leadRollout"],
    ["adapter", "adapter"],
    ["args-file", "argsFile"],
    ["argv-file", "argsFile"],
    ["result", "result"],
    ["provider-result", "result"],
    ["artifact-dir", "artifactDir"],
    ["planner2-source", "planner2Source"],
    ["planner-2-source", "planner2Source"],
    ["relay-source", "planner2Source"],
    ["confirmation", "confirmation"],
    ["confirmation-output", "confirmation"],
    ["timeout-ms", "timeoutMs"],
    ["suspension-available", "suspensionAvailable"],
    ["context-evidence-file", "contextEvidenceFile"],
    ["context-management-file", "contextEvidenceFile"],
    ["host-telemetry-file", "hostTelemetryFile"],
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected positional argument: ${token}`, "E_ARGS");
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    const key = equals >= 0 ? raw.slice(0, equals) : raw;
    const name = aliases.get(key);
    if (!name) fail(`unknown option --${key}`, "E_ARGS");
    if (Object.hasOwn(options, name)) fail(`option --${key} was supplied more than once`, "E_ARGS");
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[++index];
    if (value === undefined || value.length === 0) fail(`missing value for --${key}`, "E_ARGS");
    options[name] = value;
  }
  const required = [
    "root",
    "ledger",
    "experimentId",
    "leadRollout",
    "adapter",
    "argsFile",
    "result",
    "artifactDir",
    "planner2Source",
    "confirmation",
    "timeoutMs",
    "suspensionAvailable",
  ];
  for (const name of required) if (!Object.hasOwn(options, name)) fail(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`, "E_ARGS");
  if (options.suspensionAvailable !== "true" && options.suspensionAvailable !== "false") {
    fail("--suspension-available must be true or false", "E_ARGS");
  }
  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) fail("--timeout-ms must be a non-negative safe integer", "E_ARGS");
  options.timeoutMs = timeoutMs;
  options.suspensionAvailable = options.suspensionAvailable === "true";
  return options;
}

function safeIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail(`${label} must be 1-128 ASCII letters, digits, dot, underscore, or hyphen`, "E_ARGS");
  }
  return value;
}

function safeAdapter(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || CONTROL_CHARS.test(value)) {
    fail("--adapter must be a bounded executable string without control characters", "E_ARGS");
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeRelative(value, label, { allowRoot = false } = {}) {
  const normalized = assertRelativeInput(value, label);
  if (!allowRoot && (normalized === "." || normalized === "")) fail(`${label} must name a file or directory below the project root`, "E_PATH_ESCAPE");
  return normalized;
}

async function inspectOwnedPath(root, relative, label, { required = false, kind = "file" } = {}) {
  try {
    await assertNoReparseCrossing(root, relative, { allowMissing: !required, includeFinal: true });
  } catch (error) {
    if (required && error.code === "ENOENT") fail(`${label} does not exist: ${relative}`, "E_INPUT_PATH");
    throw error;
  }
  const absolute = absoluteFromRelative(root, relative);
  let stat;
  try {
    stat = await fsp.lstat(absolute);
  } catch (error) {
    if (!required && error.code === "ENOENT") return { relative, absolute, exists: false };
    if (required && error.code === "ENOENT") fail(`${label} does not exist: ${relative}`, "E_INPUT_PATH");
    throw error;
  }
  if (stat.isSymbolicLink()) fail(`${label} may not cross a symlink or reparse point: ${relative}`, "E_SYMLINK");
  if (kind === "file" && !stat.isFile()) fail(`${label} is not a regular file: ${relative}`, "E_FILE");
  if (kind === "directory" && !stat.isDirectory()) fail(`${label} is not a directory: ${relative}`, "E_FILE");
  return { relative, absolute, exists: true, stat };
}

function pathsOverlap(left, right) {
  const normalize = (value) => value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function assertNoOwnedOverlap(paths) {
  for (let index = 0; index < paths.length; index += 1) {
    for (let other = index + 1; other < paths.length; other += 1) {
      if (pathsOverlap(paths[index].value, paths[other].value)) {
        fail(`${paths[index].label} overlaps ${paths[other].label}`, "E_SCOPE_OVERLAP");
      }
    }
  }
}

async function inspectSource(root, relative, label) {
  const sourcePath = await inspectOwnedPath(root, relative, label, { required: true, kind: "directory" }).catch(async (error) => {
    if (error.code !== "E_FILE") throw error;
    return inspectOwnedPath(root, relative, label, { required: true, kind: "file" });
  });
  const source = resolveUsageSource(sourcePath.absolute);
  for (const file of source.files) {
    if (!inside(root, file)) continue;
    const childRelative = path.posix.normalize(path.relative(root, file).replaceAll("\\", "/"));
    await inspectOwnedPath(root, childRelative, `${label} artifact`, { required: true, kind: "file" });
  }
  return source;
}

async function inspectExactSource(root, value, label) {
  const candidate = path.resolve(value);
  if (inside(root, candidate)) {
    const relative = path.posix.normalize(path.relative(root, candidate).replaceAll("\\", "/"));
    return inspectSource(root, relative, label);
  }
  return resolveUsageSource(candidate);
}

async function parseOwnedJson(root, relative, label) {
  let value;
  try {
    value = JSON.parse((await readOwnedFile(root, relative, label)).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is not valid JSON`, "E_INPUT_JSON");
    throw error;
  }
  return value;
}

async function readAdapterArgs(root, relative) {
  const value = await parseOwnedJson(root, relative, "adapter argv file");
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || CONTROL_CHARS.test(item))) {
    fail("adapter argv file must contain a JSON array of strings without control characters", "E_ARGS_FILE");
  }
  return value;
}

function boundedContextString(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 256 || CONTROL_CHARS.test(value)) {
    fail(`${label} must be a bounded string without control characters`, "E_CONTEXT_EVIDENCE");
  }
  if (SECRET_SHAPED.test(value)) fail(`${label} appears credential-shaped and cannot be recorded`, "E_CONTEXT_EVIDENCE");
  return value;
}

function contextEvidence(value, declared) {
  if (!declared) {
    return {
      authoritative: false,
      declaredByCaller: false,
      status: "unknown",
      providerEnforcementClaim: "not_claimed",
    };
  }
  const input = value?.contextManagement && typeof value.contextManagement === "object"
    ? value.contextManagement
    : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("context evidence must be a JSON object", "E_CONTEXT_EVIDENCE");
  const output = {
    authoritative: false,
    declaredByCaller: true,
    evidenceBasis: "caller-declared non-secret context-management evidence",
    providerEnforcementClaim: "not_claimed",
  };
  for (const field of CONTEXT_STRING_FIELDS) {
    const bounded = boundedContextString(input[field], `context evidence ${field}`);
    if (bounded !== undefined) output[field] = bounded;
  }
  if (input.adapterFlagAvailable !== undefined) {
    if (typeof input.adapterFlagAvailable !== "boolean") fail("context evidence adapterFlagAvailable must be boolean", "E_CONTEXT_EVIDENCE");
    output.adapterFlagAvailable = input.adapterFlagAvailable;
  }
  if (input.thresholdPolicy !== undefined) {
    if (!input.thresholdPolicy || typeof input.thresholdPolicy !== "object" || Array.isArray(input.thresholdPolicy)) {
      fail("context evidence thresholdPolicy must be an object", "E_CONTEXT_EVIDENCE");
    }
    const threshold = {};
    for (const field of ["targetWindowTokens", "targetCompactionTokens"]) {
      if (input.thresholdPolicy[field] !== undefined) {
        if (!Number.isSafeInteger(input.thresholdPolicy[field]) || input.thresholdPolicy[field] < 0) {
          fail(`context evidence ${field} must be a non-negative safe integer`, "E_CONTEXT_EVIDENCE");
        }
        threshold[field] = input.thresholdPolicy[field];
      }
    }
    if (Object.keys(threshold).length) output.thresholdPolicy = threshold;
  }
  return output;
}

async function hostTelemetry(root, relative) {
  if (!relative) return null;
  const value = await parseOwnedJson(root, relative, "host telemetry file");
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("host telemetry must be a JSON object", "E_HOST_TELEMETRY");
  const turns = value.leadModelTurnsBetweenDispatchAndTerminal;
  if (!Number.isSafeInteger(turns) || turns < 0) fail("host telemetry must declare a non-negative leadModelTurnsBetweenDispatchAndTerminal integer", "E_HOST_TELEMETRY");
  return { leadModelTurnsBetweenDispatchAndTerminal: turns };
}

function sourceLocator(source) {
  return {
    locator: source.record?.source?.locator ?? null,
    sourceKey: source.record?.source?.sourceKey ?? null,
    sha256: source.record?.source?.sha256 ?? null,
  };
}

function controllerEvidence(outcome, artifactDir, result, capsule) {
  return {
    controllerStatus: outcome?.status ?? null,
    dispatchCount: outcome?.dispatchCount ?? 0,
    dispatchId: outcome?.dispatchId ?? null,
    idempotencyKey: outcome?.idempotencyKey ?? null,
    suspensionStatus: outcome?.suspensionStatus ?? null,
    artifactDir,
    resultPath: result,
    capsulePath: outcome?.capsulePath ?? (outcome?.status === "UNAVAILABLE" ? null : `${artifactDir}/capsule.v1.json`),
    jobPath: `${artifactDir}/job.v1.json`,
    ...(capsule?.role ? { capsuleRole: capsule.role } : {}),
  };
}

function blocked(reason, details = {}) {
  return {
    schemaVersion: BOOTSTRAP_SCHEMA,
    status: "BLOCKED",
    reason,
    ...details,
  };
}

async function validateProviderEvidence(root, resultRelative, capsuleRelative, controller) {
  let raw;
  try {
    raw = JSON.parse((await readOwnedFile(root, resultRelative, "provider result")).toString("utf8"));
  } catch (error) {
    fail("provider result could not be read as JSON", "E_PROVIDER_RESULT", controllerEvidence(controller, path.posix.dirname(capsuleRelative), resultRelative));
  }
  const validation = validateResultArtifact(raw);
  if (!validation.valid || validation.status !== "completed") {
    fail(`provider result is not a completed terminal result: ${validation.reason || raw?.status || "invalid"}`, "E_PROVIDER_RESULT", controllerEvidence(controller, path.posix.dirname(capsuleRelative), resultRelative));
  }
  const refs = extractSessionRefs(raw).filter((ref) => typeof ref.value === "string" && ref.value.length > 0);
  if (refs.length !== 1) {
    fail(`provider result must expose exactly one normalized provider session field; observed ${refs.length}`, "E_SESSION_EVIDENCE", controllerEvidence(controller, path.posix.dirname(capsuleRelative), resultRelative));
  }
  const sessionId = refs[0].value;
  if (sessionId.length > 512 || CONTROL_CHARS.test(sessionId)) fail("provider session ID is unbounded or contains control characters", "E_SESSION_EVIDENCE");
  const loaded = await loadAndValidateCapsule(root, capsuleRelative, { verifyRaw: true });
  if (!loaded.valid) fail(`planner result capsule is invalid: ${loaded.errors.join("; ")}`, "E_CAPSULE", controllerEvidence(controller, path.posix.dirname(capsuleRelative), resultRelative));
  const capsule = loaded.capsule;
  if (capsule.process?.terminalStatus !== "completed" || capsule.process?.exitCode !== 0 || capsule.process?.timedOut || capsule.process?.logDrainTimedOut || capsule.resultStatus !== "completed" || capsule.result?.status !== "completed" || capsule.resultValidation?.valid !== true || capsule.resultValidation?.status !== "completed") {
    fail("planner result capsule does not prove a successful terminal provider attempt", "E_PROVIDER_RESULT", controllerEvidence(controller, path.posix.dirname(capsuleRelative), resultRelative, capsule));
  }
  if (capsule.role !== CAPSULE_ROLE || capsule.roleStatus !== CAPSULE_STATUS || capsule.status !== CAPSULE_STATUS) {
    fail("planner result capsule does not have the required planner/NEEDS_EVIDENCE handshake role", "E_CAPSULE_ROLE", controllerEvidence(controller, path.posix.dirname(capsuleRelative), resultRelative, capsule));
  }
  if (capsule.observedSessionIds?.length !== 1 || capsule.observedSessionIds[0] !== sessionId) {
    fail("planner result capsule session evidence is not the one normalized provider session", "E_SESSION_EVIDENCE", controllerEvidence(controller, path.posix.dirname(capsuleRelative), resultRelative, capsule));
  }
  return { raw, sessionId, sessionField: refs[0].field, capsule };
}

function validateConfirmation(value, expected) {
  const errors = [];
  const allowed = new Set([
    "schemaVersion",
    "confirmationVersion",
    "status",
    "experimentId",
    "createdAt",
    "completedAt",
    "session",
    "controller",
    "plannerCapsule",
    "usage",
    "leadBoundary",
    "suspension",
    "contextManagement",
    "humanApproval",
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["confirmation is not an object"];
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`unexpected confirmation field: ${key}`);
  if (value.schemaVersion !== BOOTSTRAP_SCHEMA) errors.push("confirmation schemaVersion is invalid");
  if (value.confirmationVersion !== 1) errors.push("confirmationVersion is invalid");
  if (value.status !== "READY_FOR_VERIFICATION") errors.push("confirmation status is invalid");
  if (value.experimentId !== expected.experimentId) errors.push("confirmation experiment ID does not match");
  if (value.session?.id !== expected.sessionId || value.session?.field !== expected.sessionField) errors.push("confirmation session does not match");
  if (value.controller?.dispatchId !== expected.dispatchId || value.controller?.idempotencyKey !== expected.idempotencyKey) errors.push("confirmation controller identity does not match");
  if (value.controller?.artifactDir !== expected.artifactDir || value.controller?.jobPath !== expected.jobPath || value.controller?.resultPath !== expected.resultPath || value.controller?.capsulePath !== expected.capsulePath) errors.push("confirmation controller paths do not match");
  if (value.plannerCapsule?.path !== expected.capsulePath || value.plannerCapsule?.role !== CAPSULE_ROLE || value.plannerCapsule?.roleStatus !== CAPSULE_STATUS) errors.push("confirmation capsule does not match");
  if (value.plannerCapsule?.capsuleStatus !== "TERMINAL") errors.push("confirmation capsule status is invalid");
  if (value.usage?.ledgerPath !== expected.ledgerPath || value.usage?.leadBaselineCaptureId !== expected.leadBaselineCaptureId) errors.push("confirmation usage ledger identity does not match");
  if (value.usage?.planner2CaptureId !== expected.planner2CaptureId || value.usage?.leadBoundaryCaptureId !== expected.leadBoundaryCaptureId) errors.push("confirmation usage captures do not match");
  if (value.leadBoundary?.captureId !== expected.leadBoundaryCaptureId || value.leadBoundary?.source?.locator !== expected.leadBoundarySource.locator || value.leadBoundary?.source?.sourceKey !== expected.leadBoundarySource.sourceKey || value.leadBoundary?.source?.sha256 !== expected.leadBoundarySource.sha256 || value.leadBoundary?.limitation !== LEAD_BOUNDARY_LIMITATION) errors.push("confirmation Lead-boundary evidence is invalid");
  if (value.suspension?.status !== expected.suspensionStatus) errors.push("confirmation suspension status does not match");
  if (value.contextManagement?.authoritative !== false || value.contextManagement?.providerEnforcementClaim !== "not_claimed") errors.push("confirmation context evidence makes an enforcement claim");
  if (stableJson(value.contextManagement) !== stableJson(expected.contextManagement)) errors.push("confirmation context evidence does not match the bootstrap input");
  if (stableJson(value.suspension) !== stableJson(expected.suspension)) errors.push("confirmation suspension evidence does not match the bootstrap input");
  if (value.humanApproval?.required !== true) errors.push("confirmation does not stop for human approval");
  return errors;
}

async function writeOrReuseConfirmation(root, relative, record, expected) {
  try {
    await assertNoReparseCrossing(root, relative, { allowMissing: true, includeFinal: true });
    const absolute = absoluteFromRelative(root, relative);
    try {
      await fsp.lstat(absolute);
      const existing = JSON.parse((await readOwnedFile(root, relative, "confirmation")).toString("utf8"));
      const errors = validateConfirmation(existing, expected);
      if (errors.length) fail(`existing confirmation is not reusable: ${errors.join("; ")}`, "E_CONFIRMATION");
      return { record: existing, reused: true };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await ensureParent(root, relative);
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIRMATION_BYTES) fail("confirmation output exceeds the compact record limit", "E_CONFIRMATION");
    await fsp.writeFile(absolute, text, { encoding: "utf8", flag: "wx" });
    return { record, reused: false };
  } catch (error) {
    if (error.code === "EEXIST") {
      const existing = JSON.parse((await readOwnedFile(root, relative, "confirmation")).toString("utf8"));
      const errors = validateConfirmation(existing, expected);
      if (!errors.length) return { record: existing, reused: true };
    }
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(`confirmation could not be written: ${error.message}`, "E_CONFIRMATION");
  }
}

async function rejectConflictingConfirmation(root, prepared) {
  const inspected = await inspectOwnedPath(root, prepared.confirmation, "confirmation output", { required: false, kind: "file" });
  if (!inspected.exists) return null;
  let existing;
  try {
    existing = JSON.parse((await readOwnedFile(root, prepared.confirmation, "confirmation")).toString("utf8"));
  } catch (error) {
    fail(`existing confirmation output is not valid JSON: ${error.message}`, "E_CONFIRMATION");
  }
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) fail("existing confirmation output is not a JSON object", "E_CONFIRMATION");
  if (existing.schemaVersion !== BOOTSTRAP_SCHEMA || existing.confirmationVersion !== 1 || existing.experimentId !== prepared.experimentId) {
    fail("existing confirmation output conflicts with the requested experiment", "E_CONFIRMATION");
  }
  if (existing.status !== "READY_FOR_VERIFICATION") fail("existing confirmation output is not a completed bootstrap record", "E_CONFIRMATION");
  if (existing.controller?.dispatchId !== prepared.dispatchId || existing.controller?.idempotencyKey !== prepared.idempotencyKey) {
    fail("existing confirmation output conflicts with the requested bootstrap identity", "E_CONFIRMATION");
  }
  if (existing.controller?.artifactDir !== prepared.artifactDir) fail("existing confirmation output points at a different controller artifact directory", "E_CONFIRMATION");
  return existing;
}

function requiredUsageCapture(rows, captureId, role, label) {
  if (typeof captureId !== "string" || captureId.length === 0) fail(`${label} capture ID is missing`, "E_CONFIRMATION");
  const row = rows.find((candidate) => candidate.type === "usage_capture" && candidate.captureId === captureId);
  if (!row || row.role !== role) fail(`${label} capture is missing or has the wrong role`, "E_CONFIRMATION");
  return row;
}

async function reuseCompletedBootstrap(root, prepared, existing) {
  const ledgerAbsolute = absoluteFromRelative(root, prepared.ledger);
  let rows;
  try {
    rows = readUsageLedger(ledgerAbsolute);
  } catch (error) {
    fail(`completed confirmation cannot reuse its usage ledger: ${error.message}`, "E_CONFIRMATION");
  }
  if (rows[0].experimentId !== prepared.experimentId || (rows[0].root && rows[0].root !== root)) {
    fail("completed confirmation points at a conflicting usage ledger", "E_CONFIRMATION");
  }

  const baselines = rows.filter((row) => row.type === "usage_capture" && row.role === "planning-lead" && row.baseline === true);
  if (baselines.length !== 1 || baselines[0].captureId !== existing.usage?.leadBaselineCaptureId || baselines[0].source?.sourceKey !== prepared.leadSource.sourceKey) {
    fail("completed confirmation does not point at one matching Planning Lead baseline", "E_CONFIRMATION");
  }
  const prefix = usageSourcePrefixMatches(prepared.leadSource, root, baselines[0].source?.prefix);
  if (!prefix.valid) fail(`completed confirmation cannot reconcile the Planning Lead rollout: ${prefix.reason}`, "E_CONFIRMATION");

  const plannerUsage = requiredUsageCapture(rows, existing.usage?.planner2CaptureId, "planner-2", "Planner 2 usage");
  const leadBoundary = requiredUsageCapture(rows, existing.usage?.leadBoundaryCaptureId, "planning-lead", "Planning Lead boundary");
  if (leadBoundary.captureKind !== "planning-lead-confirmation-boundary") fail("completed confirmation points at the wrong Planning Lead boundary", "E_CONFIRMATION");
  if (stableJson(sourceLocator({ record: leadBoundary })) !== stableJson(existing.leadBoundary?.source)) {
    fail("completed confirmation boundary source does not match the usage ledger", "E_CONFIRMATION");
  }

  const capsuleRelative = `${prepared.artifactDir}/capsule.v1.json`;
  const jobRelative = `${prepared.artifactDir}/job.v1.json`;
  const job = await parseOwnedJson(root, jobRelative, "controller job record");
  if (job.dispatchId !== prepared.dispatchId || job.idempotencyKey !== prepared.idempotencyKey) {
    fail("completed confirmation controller job identity does not match", "E_CONFIRMATION");
  }
  const controller = {
    status: "REUSED",
    dispatchCount: 0,
    dispatchId: prepared.dispatchId,
    idempotencyKey: prepared.idempotencyKey,
    capsulePath: capsuleRelative,
  };
  const provider = await validateProviderEvidence(root, prepared.result, capsuleRelative, controller);
  const expected = {
    experimentId: prepared.experimentId,
    sessionId: provider.sessionId,
    sessionField: provider.sessionField,
    dispatchId: prepared.dispatchId,
    idempotencyKey: prepared.idempotencyKey,
    capsulePath: capsuleRelative,
    artifactDir: prepared.artifactDir,
    jobPath: jobRelative,
    resultPath: prepared.result,
    ledgerPath: prepared.ledger,
    leadBaselineCaptureId: baselines[0].captureId,
    planner2CaptureId: plannerUsage.captureId,
    leadBoundaryCaptureId: leadBoundary.captureId,
    leadBoundarySource: sourceLocator({ record: leadBoundary }),
    suspensionStatus: provider.capsule.suspensionStatus,
    suspension: {
      status: provider.capsule.suspensionStatus,
      evidence: provider.capsule.suspensionEvidence,
      hostTelemetry: provider.capsule.hostTelemetry,
    },
    contextManagement: prepared.context,
  };
  const errors = validateConfirmation(existing, expected);
  if (errors.length) fail(`existing confirmation is not reusable: ${errors.join("; ")}`, "E_CONFIRMATION");
  return {
    schemaVersion: BOOTSTRAP_SCHEMA,
    status: "READY_FOR_VERIFICATION",
    experimentId: prepared.experimentId,
    sessionId: provider.sessionId,
    sessionField: provider.sessionField,
    controllerStatus: "REUSED",
    dispatchCount: 0,
    reused: true,
    confirmationReused: true,
    dispatchId: prepared.dispatchId,
    idempotencyKey: prepared.idempotencyKey,
    ledgerPath: prepared.ledger,
    resultPath: prepared.result,
    artifactDir: prepared.artifactDir,
    jobPath: jobRelative,
    capsulePath: capsuleRelative,
    planner2UsageCaptureId: plannerUsage.captureId,
    leadBaselineCaptureId: baselines[0].captureId,
    leadBoundaryCaptureId: leadBoundary.captureId,
    confirmationPath: prepared.confirmation,
    suspensionStatus: provider.capsule.suspensionStatus,
    contextManagement: prepared.context,
    leadBoundaryLimitation: LEAD_BOUNDARY_LIMITATION,
    humanApprovalRequired: true,
  };
}

async function preflight(options, root) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) fail("timeoutMs must be a non-negative safe integer", "E_ARGS");
  if (typeof options.suspensionAvailable !== "boolean") fail("suspensionAvailable must be explicitly true or false", "E_ARGS");
  const ledger = normalizeRelative(options.ledger, "ledger path");
  const argsFile = normalizeRelative(options.argsFile, "adapter argv path");
  const result = normalizeRelative(options.result, "provider result path");
  const artifactDir = normalizeRelative(options.artifactDir, "controller artifact directory");
  const planner2Source = normalizeRelative(options.planner2Source, "Planner 2 relay source");
  const confirmation = normalizeRelative(options.confirmation, "confirmation output");
  const contextEvidencePath = options.contextEvidenceFile
    ? normalizeRelative(options.contextEvidenceFile, "context evidence path")
    : null;
  const hostTelemetryPath = options.hostTelemetryFile
    ? normalizeRelative(options.hostTelemetryFile, "host telemetry path")
    : null;
  if (SECRET_SHAPED.test(options.experimentId)) fail("experiment ID appears credential-shaped", "E_ARGS");
  const experimentId = safeIdentifier(options.experimentId, "experiment ID");
  const adapter = safeAdapter(options.adapter);

  await inspectOwnedPath(root, ledger, "ledger path", { required: false, kind: "file" });
  await inspectOwnedPath(root, argsFile, "adapter argv path", { required: true, kind: "file" });
  await inspectOwnedPath(root, result, "provider result path", { required: false, kind: "file" });
  await inspectOwnedPath(root, artifactDir, "controller artifact directory", { required: false, kind: "directory" });
  await inspectOwnedPath(root, confirmation, "confirmation output", { required: false, kind: "file" });
  if (contextEvidencePath) await inspectOwnedPath(root, contextEvidencePath, "context evidence path", { required: true, kind: "file" });
  if (hostTelemetryPath) await inspectOwnedPath(root, hostTelemetryPath, "host telemetry path", { required: true, kind: "file" });

  const ownedFiles = [
    { label: "ledger path", value: ledger },
    { label: "adapter argv path", value: argsFile },
    { label: "provider result path", value: result },
    { label: "controller artifact directory", value: artifactDir },
    { label: "confirmation output", value: confirmation },
    { label: "Planner 2 relay source", value: planner2Source },
  ];
  if (contextEvidencePath) ownedFiles.push({ label: "context evidence path", value: contextEvidencePath });
  if (hostTelemetryPath) ownedFiles.push({ label: "host telemetry path", value: hostTelemetryPath });
  assertNoOwnedOverlap(ownedFiles);

  const args = await readAdapterArgs(root, argsFile);
  const leadSource = await inspectExactSource(root, options.leadRollout, "Planning Lead rollout");
  const leadRelative = inside(root, leadSource.requestedPath)
    ? path.posix.normalize(path.relative(root, leadSource.requestedPath).replaceAll("\\", "/"))
    : null;
  if (leadRelative) assertNoOwnedOverlap([...ownedFiles, { label: "Planning Lead rollout", value: leadRelative }]);
  const sourceFiles = [];
  for (const file of leadSource.files) {
    if (!inside(root, file)) continue;
    sourceFiles.push({
      label: "Planning Lead rollout artifact",
      value: path.posix.normalize(path.relative(root, file).replaceAll("\\", "/")),
    });
  }
  const generatedAndOtherInputs = ownedFiles.filter(({ label }) => label !== "Planner 2 relay source");
  for (const sourceFile of sourceFiles) assertNoOwnedOverlap([...generatedAndOtherInputs, sourceFile]);
  const context = contextEvidencePath
    ? contextEvidence(await parseOwnedJson(root, contextEvidencePath, "context evidence file"), true)
    : contextEvidence(null, false);
  const telemetry = hostTelemetryPath
    ? await hostTelemetry(root, hostTelemetryPath)
    : null;
  await ensureParent(root, ledger);
  await ensureParent(root, result);
  await ensureParent(root, artifactDir);
  await ensureParent(root, confirmation);
  const identity = {
    schemaVersion: "dd.planner2-bootstrap-identity.v1",
    experimentId,
    leadRollout: leadSource.requestedPath,
    adapter,
    args,
    argsFile,
    result,
    artifactDir,
    planner2Source,
    confirmation,
    ledger,
    timeoutMs: options.timeoutMs,
    suspensionAvailable: options.suspensionAvailable,
    context,
    hostTelemetry: telemetry,
  };
  const identityDigest = crypto.createHash("sha256").update(stableJson(identity)).digest("hex");
  return {
    root,
    experimentId,
    adapter,
    args,
    ledger,
    argsFile,
    result,
    artifactDir,
    planner2Source,
    leadSource,
    confirmation,
    context,
    telemetry,
    dispatchId: `dd-bootstrap-${identityDigest}`,
    idempotencyKey: `dd:planner2-bootstrap:${identityDigest}`,
  };
}

export async function runBootstrap(options) {
  const root = await realDirectory(options.root, "root");
  const prepared = await preflight(options, root);
  const existingConfirmation = await rejectConflictingConfirmation(root, prepared);
  if (existingConfirmation) return reuseCompletedBootstrap(root, prepared, existingConfirmation);
  const ledgerAbsolute = absoluteFromRelative(root, prepared.ledger);
  const ledgerState = ensureUsageLedger({ ledgerPath: ledgerAbsolute, experimentId: prepared.experimentId, root });

  const rows = ledgerState.rows;
  const existingBaselines = rows.filter((row) => row.type === "usage_capture" && row.role === "planning-lead" && row.baseline === true);
  let leadBaseline;
  if (existingBaselines.length > 0) {
    const existing = existingBaselines.length === 1 ? existingBaselines[0] : null;
    if (!existing || existing.source?.sourceKey !== prepared.leadSource.sourceKey) {
      fail("existing Planning Lead baseline conflicts with the exact rollout source", "E_LEAD_BASELINE");
    }
    const prefix = usageSourcePrefixMatches(prepared.leadSource, root, existing.source?.prefix);
    if (!prefix.valid) fail(`existing Planning Lead baseline cannot be reconciled: ${prefix.reason}`, "E_LEAD_BASELINE");
    leadBaseline = { duplicate: true, captureId: existing.captureId, record: existing, source: prepared.leadSource };
  } else {
    try {
      leadBaseline = captureUsage({
        ledgerPath: ledgerAbsolute,
        root,
        role: "planning-lead",
        source: prepared.leadSource.requestedPath,
        label: "planner-2-bootstrap-baseline",
        baseline: true,
        captureKind: "planning-lead-baseline",
      });
    } catch (error) {
      fail(`Planning Lead baseline capture failed: ${error.message}`, "E_LEAD_BASELINE");
    }
  }
  if (!leadBaseline.record?.baseline) fail("Planning Lead baseline capture was not recorded as zero-delta", "E_LEAD_BASELINE");

  const controller = await dispatchProcessJob({
    root,
    adapter: prepared.adapter,
    args: prepared.args,
    result: prepared.result,
    artifactDir: prepared.artifactDir,
    jobRecord: `${prepared.artifactDir}/job.v1.json`,
    capsule: `${prepared.artifactDir}/capsule.v1.json`,
    role: CAPSULE_ROLE,
    dispatchId: prepared.dispatchId,
    idempotencyKey: prepared.idempotencyKey,
    suspensionAvailable: options.suspensionAvailable,
    hostTelemetry: prepared.telemetry,
    timeoutMs: options.timeoutMs,
  });
  if (controller.status === "UNAVAILABLE") {
    return blocked("suspension is unavailable; no provider was dispatched", {
      experimentId: prepared.experimentId,
      controller: controllerEvidence(controller, prepared.artifactDir, prepared.result),
      ledgerPath: prepared.ledger,
    });
  }
  if (controller.status !== "PASS" && controller.status !== "REUSED") {
    return blocked(`provider dispatch did not produce a reusable terminal result: ${controller.failureReasons?.join("; ") || controller.reason || controller.status}`, {
      experimentId: prepared.experimentId,
      controller: controllerEvidence(controller, prepared.artifactDir, prepared.result, controller.capsule),
      ledgerPath: prepared.ledger,
    });
  }
  const capsuleRelative = `${prepared.artifactDir}/capsule.v1.json`;
  let provider;
  try {
    provider = await validateProviderEvidence(root, prepared.result, capsuleRelative, controller);
  } catch (error) {
    if (error instanceof BootstrapError) throw error;
    throw new BootstrapError(`provider evidence validation failed: ${error.message}`, "E_PROVIDER_RESULT", controllerEvidence(controller, prepared.artifactDir, prepared.result, controller.capsule));
  }

  let plannerUsage;
  try {
    const plannerSource = await inspectSource(root, prepared.planner2Source, "Planner 2 relay source");
    plannerUsage = captureUsage({
      ledgerPath: ledgerAbsolute,
      root,
      role: "planner-2",
      source: plannerSource.requestedPath,
      label: "planner-2-bootstrap-relay",
      captureKind: "planner-2-relay",
    });
  } catch (error) {
    throw new BootstrapError(`Planner 2 usage capture failed: ${error.message}`, "E_PLANNER_USAGE", controllerEvidence(controller, prepared.artifactDir, prepared.result, provider.capsule));
  }

  let leadBoundary;
  try {
    leadBoundary = captureUsage({
      ledgerPath: ledgerAbsolute,
      root,
      role: "planning-lead",
      source: prepared.leadSource.requestedPath,
      label: "planner-2-bootstrap-confirmation-boundary",
      idempotencyNamespace: LEAD_BOUNDARY_NAMESPACE,
      captureKind: "planning-lead-confirmation-boundary",
    });
  } catch (error) {
    throw new BootstrapError(`Planning Lead confirmation boundary capture failed: ${error.message}`, "E_LEAD_BOUNDARY", controllerEvidence(controller, prepared.artifactDir, prepared.result, provider.capsule));
  }
  if (!leadBoundary.record || leadBoundary.record.role !== "planning-lead") fail("Planning Lead confirmation boundary was not recorded", "E_LEAD_BOUNDARY");

  const expected = {
    experimentId: prepared.experimentId,
    sessionId: provider.sessionId,
    sessionField: provider.sessionField,
    dispatchId: controller.dispatchId,
    idempotencyKey: controller.idempotencyKey,
    capsulePath: capsuleRelative,
    artifactDir: prepared.artifactDir,
    jobPath: `${prepared.artifactDir}/job.v1.json`,
    resultPath: prepared.result,
    ledgerPath: prepared.ledger,
    leadBaselineCaptureId: leadBaseline.record.captureId,
    planner2CaptureId: plannerUsage.record.captureId,
    leadBoundaryCaptureId: leadBoundary.record.captureId,
    leadBoundarySource: sourceLocator(leadBoundary),
    suspensionStatus: provider.capsule.suspensionStatus,
    suspension: {
      status: provider.capsule.suspensionStatus,
      evidence: provider.capsule.suspensionEvidence,
      hostTelemetry: provider.capsule.hostTelemetry,
    },
    contextManagement: prepared.context,
  };
  const confirmationRecord = {
    schemaVersion: BOOTSTRAP_SCHEMA,
    confirmationVersion: 1,
    status: "READY_FOR_VERIFICATION",
    experimentId: prepared.experimentId,
    createdAt: provider.capsule.createdAt,
    completedAt: provider.capsule.completedAt,
    session: { id: provider.sessionId, field: provider.sessionField },
    controller: {
      status: controller.status,
      dispatchCount: controller.dispatchCount,
      dispatchId: controller.dispatchId,
      idempotencyKey: controller.idempotencyKey,
      artifactDir: prepared.artifactDir,
      jobPath: `${prepared.artifactDir}/job.v1.json`,
      capsulePath: capsuleRelative,
      resultPath: prepared.result,
    },
    plannerCapsule: {
      path: capsuleRelative,
      role: provider.capsule.role,
      roleStatus: provider.capsule.roleStatus,
      capsuleStatus: provider.capsule.capsuleStatus,
    },
    usage: {
      ledgerPath: prepared.ledger,
      leadBaselineCaptureId: leadBaseline.record.captureId,
      planner2CaptureId: plannerUsage.record.captureId,
      leadBoundaryCaptureId: leadBoundary.record.captureId,
    },
    leadBoundary: {
      captureId: leadBoundary.record.captureId,
      source: sourceLocator(leadBoundary),
      limitation: LEAD_BOUNDARY_LIMITATION,
    },
    suspension: {
      status: provider.capsule.suspensionStatus,
      evidence: provider.capsule.suspensionEvidence,
      hostTelemetry: provider.capsule.hostTelemetry,
    },
    contextManagement: prepared.context,
    humanApproval: {
      required: true,
      nextAction: "return once for direct human approval; no authorization is inferred",
    },
  };
  const written = await writeOrReuseConfirmation(root, prepared.confirmation, confirmationRecord, expected);
  return {
    schemaVersion: BOOTSTRAP_SCHEMA,
    status: "READY_FOR_VERIFICATION",
    experimentId: prepared.experimentId,
    sessionId: provider.sessionId,
    sessionField: provider.sessionField,
    controllerStatus: controller.status,
    dispatchCount: controller.dispatchCount,
    reused: controller.status === "REUSED",
    confirmationReused: written.reused,
    dispatchId: controller.dispatchId,
    idempotencyKey: controller.idempotencyKey,
    ledgerPath: prepared.ledger,
    resultPath: prepared.result,
    artifactDir: prepared.artifactDir,
    jobPath: `${prepared.artifactDir}/job.v1.json`,
    capsulePath: capsuleRelative,
    planner2UsageCaptureId: plannerUsage.record.captureId,
    leadBaselineCaptureId: leadBaseline.record.captureId,
    leadBoundaryCaptureId: leadBoundary.record.captureId,
    confirmationPath: prepared.confirmation,
    suspensionStatus: provider.capsule.suspensionStatus,
    contextManagement: prepared.context,
    leadBoundaryLimitation: LEAD_BOUNDARY_LIMITATION,
    humanApprovalRequired: true,
  };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = await runBootstrap(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "READY_FOR_VERIFICATION" ? 0 : 1;
  } catch (error) {
    const details = error instanceof BootstrapError ? error.details : {};
    const message = error instanceof BootstrapError ? error.message : `bootstrap failed: ${error.message}`;
    process.stderr.write(`dd-bootstrap: ${message}\n`);
    process.stdout.write(`${JSON.stringify(blocked(message, details))}\n`);
    return ["E_ARGS", "E_PATH_ESCAPE", "E_PATH_TRAVERSAL", "E_INPUT_PATH", "E_ARGS_FILE", "E_INPUT_JSON", "E_CONTEXT_EVIDENCE", "E_HOST_TELEMETRY"].includes(error.code) ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`dd-bootstrap: ${error.message}\n`);
    process.exitCode = 2;
  });
}

export { parseArgs, validateConfirmation };
