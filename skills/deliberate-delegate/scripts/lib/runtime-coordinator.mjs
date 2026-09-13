import fs from "node:fs/promises";
import path from "node:path";
import {
  absoluteFromRelative,
  ABSOLUTE_CORRECTION_CEILING,
  assertNoReparseCrossing,
  assertRelativeInput,
  extractSessionRefs,
  fail,
  hashRegularFile,
  readOwnedFile,
  realDirectory,
  sha256Bytes,
  stableJson,
  validateResultArtifact,
  writeNewFile,
} from "./lifecycle-core.mjs";
import {
  DEFAULT_RECORDS_ROOT,
  PROJECT_CONFIG_SCHEMA,
  canonicalRecordBytes,
  confirmConfiguration,
  createConfigurationDraft,
  createQuestionnaire,
  deriveActiveConfiguration,
  digestRecordBytes,
} from "./project-config.mjs";
import {
  answerQuestion,
  inspectQuestion,
  listQuestions,
  openQuestion,
  questionApplies,
  withdrawQuestion,
} from "./question-queue.mjs";
import { dispatchProcessJob, invocationContractDigest, loadAdapterEnvelopeFile } from "./job-controller.mjs";
import { validateResultCapsule } from "./result-capsule.mjs";

export const RUNTIME_SCHEMA = "dd-runtime.v1";
export const EVENT_SCHEMA = "dd.runtime-event.v1";
export const STATUS_SCHEMA = "dd.runtime-status.v1";
export const DISPATCH_REQUEST_SCHEMA = "dd.runtime-dispatch.v1";
export const SESSION_BINDING_SCHEMA = "dd.session-binding.v1";
export const SESSION_BINDING_REQUEST_SCHEMA = "dd.session-binding-request.v1";
export const RESULT_ACKNOWLEDGEMENT_SCHEMA = "dd.result-acknowledgement.v1";
export const PUBLIC_ROLES = Object.freeze(["planner-2", "executor"]);
export const CONTROLLER_ROLES = Object.freeze({ "planner-2": "planner", executor: "executor" });
export const NEXT_STOPS = Object.freeze([
  "AWAITING_CONFIGURATION_CONFIRMATION",
  "AWAITING_HUMAN_ANSWER",
  "AWAITING_SESSION_BINDING",
  "READY_FOR_AUTHORIZED_DISPATCH",
  "RESULT_READY_FOR_PLANNING_LEAD",
  "STOPPED",
]);

function requiredText(value, label, max = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${label} must be a non-empty string of at most ${max} characters`, "E_RUNTIME_FIELD");
  return value;
}

function roleName(value) {
  const role = String(value || "").toLowerCase();
  if (!PUBLIC_ROLES.includes(role)) fail(`role must be planner-2 or executor: ${value}`, "E_RUNTIME_ROLE");
  return role;
}

function encodedKey(value, label) {
  const text = requiredText(value, label, 512);
  if (text === "." || text === ".." || /[\u0000-\u001f\u007f]/.test(text)) fail(`${label} contains an invalid control character`, "E_RUNTIME_KEY");
  return encodeURIComponent(text).replaceAll("%", "_");
}

function scopeComponent(value, label) {
  const text = requiredText(value, label, 256);
  if (text === "." || text === ".." || /[\u0000-\u001f\u007f]/.test(text)) fail(`${label} contains an invalid control character`, "E_SESSION_SCOPE");
  try {
    return encodeURIComponent(text);
  } catch (error) {
    fail(`${label} cannot be canonically encoded: ${error.message}`, "E_SESSION_SCOPE");
  }
}

function decodedScopeComponent(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is missing from the canonical session scope`, "E_BINDING_SCOPE");
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (error) {
    fail(`${label} is not valid URI encoding: ${error.message}`, "E_BINDING_SCOPE");
  }
  if (scopeComponent(decoded, label) !== value) fail(`${label} is not canonically encoded`, "E_BINDING_SCOPE");
  return decoded;
}

function canonicalSessionScopeForRole(publicRole, scope) {
  const role = roleName(publicRole);
  const value = requiredText(scope, "session scope", 4096);
  if (role === "planner-2") {
    if (value === "project") return value;
    if (!value.startsWith("phase:")) fail("Planner 2 session scope must be project or canonical phase:<phaseKey>", "E_BINDING_SCOPE");
    const encodedPhase = value.slice("phase:".length);
    const phase = decodedScopeComponent(encodedPhase, "phaseKey");
    const canonical = `phase:${scopeComponent(phase, "phaseKey")}`;
    if (canonical !== value) fail("Planner 2 session scope is not canonical", "E_BINDING_SCOPE");
    return canonical;
  }
  if (!value.startsWith("work-package:")) fail("Executor session scope must be canonical work-package:<phaseKey>/<workPackageKey>", "E_BINDING_SCOPE");
  const encodedTuple = value.slice("work-package:".length);
  const separator = encodedTuple.indexOf("/");
  if (separator <= 0 || separator !== encodedTuple.lastIndexOf("/")) fail("Executor session scope must contain exactly one tuple separator", "E_BINDING_SCOPE");
  const phase = decodedScopeComponent(encodedTuple.slice(0, separator), "phaseKey");
  const workPackage = decodedScopeComponent(encodedTuple.slice(separator + 1), "workPackageKey");
  const canonical = `work-package:${scopeComponent(phase, "phaseKey")}/${scopeComponent(workPackage, "workPackageKey")}`;
  if (canonical !== value) fail("Executor session scope is not canonical", "E_BINDING_SCOPE");
  return canonical;
}

export function canonicalSessionScope(publicRole, scope) {
  return canonicalSessionScopeForRole(publicRole, scope);
}

function recordsRootValue(value = DEFAULT_RECORDS_ROOT) {
  const root = assertRelativeInput(value, "recordsRoot");
  if (root === ".") fail("recordsRoot must not be the project root", "E_RUNTIME_FIELD");
  return root;
}

function padAttempt(value) {
  if (!Number.isInteger(value) || value < 1 || value > 999999) fail("attempt must be a positive bounded integer", "E_RUNTIME_ATTEMPT");
  return String(value).padStart(2, "0");
}

function runtimePath(recordsRoot, suffix) {
  return `${recordsRoot}/runtime/${suffix}`;
}

function bindingRoleDirectory(recordsRoot, role) {
  return runtimePath(recordsRoot, `bindings/${encodedKey(role, "role")}`);
}

function scopeDigest(scope, role = null) {
  const canonical = role === null ? requiredText(scope, "session scope", 4096) : canonicalSessionScopeForRole(role, scope);
  return sha256Bytes(canonical);
}

function bindingScopeDirectory(recordsRoot, role, scope) {
  const canonical = canonicalSessionScopeForRole(role, scope);
  return `${bindingRoleDirectory(recordsRoot, role)}/${scopeDigest(canonical, role)}`;
}

function pendingBindingPath(role, scope, recordsRoot, { replacementVersion = null } = {}) {
  const name = replacementVersion === null ? "pending.v1.json" : `pending-replacement.v${replacementVersion}.json`;
  return `${bindingScopeDirectory(recordsRoot, role, scope)}/${name}`;
}

function bindingPath(role, scope, version, recordsRoot) {
  return `${bindingScopeDirectory(recordsRoot, role, scope)}/binding.v${version}.json`;
}

function eventPath(eventId, recordsRoot) {
  return runtimePath(recordsRoot, `events/${encodedKey(eventId, "eventId")}.json`);
}

function canonicalDigest(value) {
  return digestRecordBytes(canonicalRecordBytes(value));
}

async function readJsonRecord(root, relative, label = "runtime record") {
  const bytes = await readOwnedFile(root, relative, label);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes, digest: sha256Bytes(bytes), path: relative };
  } catch (error) {
    fail(`malformed ${label}: ${error.message}`, "E_RECORD_MALFORMED");
  }
}

async function readJsonIfPresent(root, relative, label = "runtime record") {
  try {
    return await readJsonRecord(root, relative, label);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeImmutableRecord(root, relative, value) {
  const bytes = canonicalRecordBytes(value);
  try {
    await assertNoReparseCrossing(root, relative, { allowMissing: false, includeFinal: true });
    const existing = await readOwnedFile(root, relative, "immutable runtime record");
    if (Buffer.compare(existing, bytes) === 0) return { status: "REUSED", path: relative, digest: sha256Bytes(existing), value, reused: true };
    fail(`immutable runtime record already exists with contradictory bytes: ${relative}`, "E_RECORD_CONTRADICTION");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeNewFile(root, relative, bytes);
    return { status: "CREATED", path: relative, digest: sha256Bytes(bytes), value, reused: false };
  }
}

async function fileReference(root, relative, label = "record") {
  const bytes = await readOwnedFile(root, relative, label);
  return { path: relative, sha256: sha256Bytes(bytes) };
}

async function recordEvent({ root, recordsRoot, eventType, eventId, references = [], data = {} }) {
  requiredText(eventType, "eventType", 128);
  const identity = { eventType, references, data };
  const id = eventId ?? `event-${sha256Bytes(stableJson(identity)).slice(0, 40)}`;
  const record = {
    schemaVersion: EVENT_SCHEMA,
    eventVersion: 1,
    eventId: id,
    eventType,
    references,
    data,
  };
  return writeImmutableRecord(root, eventPath(id, recordsRoot), record);
}

async function stopRecord({ root, recordsRoot, jobKey, attempt, code, reason, data = {} }) {
  const record = {
    schemaVersion: "dd.runtime-stop.v1",
    status: "STOPPED",
    code,
    reason,
    data,
  };
  const digest = canonicalDigest(record);
  const relative = jobKey
    ? runtimePath(recordsRoot, `jobs/${jobKey}/attempt-${padAttempt(attempt)}/stops/stop-${digest}.json`)
    : runtimePath(recordsRoot, `stops/stop-${digest}.json`);
  try {
    const written = await writeImmutableRecord(root, relative, record);
    return { ...written, stopPath: relative, status: "STOPPED", stopCode: code, reason };
  } catch (error) {
    return {
      status: "STOPPED",
      stopCode: "STOPPED_STOP_RECORD_CONTRADICTION",
      reason: `runtime stop record could not be reconciled: ${error.message}`,
      stopPath: relative,
      digest: null,
      reused: false,
      recordCollision: true,
    };
  }
}

function configRoleKey(publicRole) {
  return publicRole === "planner-2" ? "planner2" : "executor";
}

function capabilityToWaitPath(capability) {
  if (capability === "single_outer_call") return "single_outer_call";
  if (capability === "described_equivalent") return "described_equivalent";
  return "unavailable";
}

function parseNumericTimeout(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value === "string") {
    const match = value.match(/^(\d+)\s*(ms|s|m|h)$/i);
    if (match) {
      const number = Number(match[1]);
      const factor = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2].toLowerCase()];
      return number * factor;
    }
  }
  return undefined;
}

function isClaudePlanner2(publicRole, providerFamily) {
  return publicRole === "planner-2" && providerFamily === "claude";
}

function inspectAutocompactArgv(args, adapterIdentifier) {
  const declarations = [];
  const terminator = args.indexOf("--");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--autocompact") {
      if (args[index + 1] === undefined || String(args[index + 1]).startsWith("--")) {
        declarations.push({ form: "separated", value: null, index, postTerminator: terminator >= 0 && index > terminator });
      } else {
        declarations.push({ form: "separated", value: args[index + 1], index, postTerminator: terminator >= 0 && index > terminator });
        index += 1;
      }
    } else if (typeof arg === "string" && arg.startsWith("--autocompact=")) {
      declarations.push({ form: "equals", value: arg.slice("--autocompact=".length), index, postTerminator: terminator >= 0 && index > terminator });
    }
  }
  const effective = declarations.filter((item) => item.value === "400k");
  const realRelayGrammar = adapterIdentifier === "claude-delegate";
  const valid = declarations.length === 1 && effective.length === 1 && declarations[0].form === "separated" && declarations[0].postTerminator !== true && (realRelayGrammar || declarations[0].form === "separated");
  return {
    valid,
    declarations,
    grammar: realRelayGrammar ? "claude-delegate-separated-option-list" : "bounded-adapter-separated-option-list",
    reason: declarations.length === 0 ? "missing --autocompact declaration" : valid ? null : "missing, malformed, duplicate, equals-form, post-terminator, or contradictory --autocompact declaration",
  };
}

function contextEvidence(publicRole, providerFamily, adapterIdentifier, args, evidence) {
  if (!isClaudePlanner2(publicRole, providerFamily)) return null;
  const inspection = inspectAutocompactArgv(args, adapterIdentifier);
  if (!inspection.valid) return { authoritative: false, providerFamily, requestedSetting: "--autocompact 400k", preflightStatus: "rejected", argvInspection: inspection, callerTelemetry: evidence ?? null };
  return {
    authoritative: false,
    role: "planner2",
    providerFamily: "claude",
    requiredMode: "automatic",
    requestedSetting: "--autocompact 400k",
    capability: "adapter_flag",
    effectiveSettingEvidence: "actual dispatch argv inspection proves one requested --autocompact 400k declaration",
    preflightStatus: "verified",
    argvInspection: inspection,
    callerTelemetry: evidence ?? null,
    providerApplication: "unknown",
    thresholdPolicy: { targetWindowTokens: 1000000, targetCompactionTokens: 400000 },
    observedOccupancy: "unknown",
    adapterFlagAvailable: true,
  };
}

async function bindingRecords(root, recordsRoot, role, scope = null) {
  const canonicalScope = scope === null ? null : canonicalSessionScopeForRole(role, scope);
  const roleRelative = bindingRoleDirectory(recordsRoot, role);
  const roleAbsolute = absoluteFromRelative(root, roleRelative);
  try {
    await assertNoReparseCrossing(root, roleRelative, { allowMissing: false, includeFinal: true });
    const scopeEntries = scope === null
      ? (await fs.readdir(roleAbsolute, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, scope: null }))
      : [{ name: scopeDigest(canonicalScope, role), scope: canonicalScope }];
    const values = [];
    for (const scopeEntry of scopeEntries) {
      const relative = `${roleRelative}/${scopeEntry.name}`;
      const absolute = absoluteFromRelative(root, relative);
      await assertNoReparseCrossing(root, relative, { allowMissing: false, includeFinal: true });
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        const match = entry.name.match(/^binding\.v(\d+)\.json$/i);
        if (!entry.isFile() || !match) continue;
        const version = Number(match[1]);
        if (entry.name !== `binding.v${version}.json`) fail(`binding filename is not canonically versioned: ${relative}/${entry.name}`, "E_BINDING_RECORD");
        const loaded = await readJsonRecord(root, `${relative}/${entry.name}`, "session binding record");
        if (loaded.value.schemaVersion !== SESSION_BINDING_SCHEMA) fail(`invalid session binding schema: ${loaded.path}`, "E_BINDING_RECORD");
        if (typeof loaded.value.scope !== "string" || scopeDigest(loaded.value.scope, role) !== scopeEntry.name) fail(`session binding scope does not match its directory: ${loaded.path}`, "E_BINDING_RECORD");
        const loadedScope = canonicalSessionScopeForRole(role, loaded.value.scope);
        if (scope !== null && loadedScope !== canonicalScope) fail(`session binding scope does not match the requested scope: ${loaded.path}`, "E_BINDING_RECORD");
        const hasRequestPath = Object.prototype.hasOwnProperty.call(loaded.value, "bindingRequestPath");
        const hasRequestDigest = Object.prototype.hasOwnProperty.call(loaded.value, "bindingRequestDigest");
        if (hasRequestPath !== hasRequestDigest) fail(`session binding request reference is incomplete: ${loaded.path}`, "E_BINDING_RECORD");
        if (hasRequestPath) {
          assertRelativeInput(loaded.value.bindingRequestPath, "bindingRequestPath");
          if (typeof loaded.value.bindingRequestDigest !== "string" || !/^[a-f0-9]{64}$/i.test(loaded.value.bindingRequestDigest)) fail(`session binding request digest is invalid: ${loaded.path}`, "E_BINDING_RECORD");
        }
        values.push({ ...loaded, version });
      }
    }
    const ordered = values.sort((left, right) => left.version - right.version);
    if (canonicalScope !== null) validateBindingChain(ordered, role, canonicalScope);
    else {
      for (const readableScope of new Set(ordered.map((item) => item.value.scope))) {
        validateBindingChain(ordered.filter((item) => item.value.scope === readableScope), role, readableScope);
      }
    }
    return ordered;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function validateBindingChain(records, role, scope) {
  const ordered = [...records].sort((left, right) => left.version - right.version);
  const versions = new Set();
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index];
    if (versions.has(item.version) || item.value.version !== item.version) fail(`binding version is duplicated or inconsistent with its filename: ${item.path}`, "E_BINDING_CHAIN");
    versions.add(item.version);
    if (item.value.publicRole !== role || item.value.scope !== scope || item.value.schemaVersion !== SESSION_BINDING_SCHEMA) fail(`binding role/scope contradicts its directory: ${item.path}`, "E_BINDING_CHAIN");
    const expectedVersion = index + 1;
    if (item.version !== expectedVersion) fail(`binding chain has a skipped or missing version before v${item.version}`, "E_BINDING_CHAIN");
    const supersedes = item.value.supersedes ?? null;
    if (item.version === 1) {
      if (supersedes !== null) fail(`binding v1 must have no predecessor: ${item.path}`, "E_BINDING_CHAIN");
    } else {
      const prior = ordered[index - 1];
      if (typeof supersedes !== "string" || supersedes !== prior.digest || prior.version !== item.version - 1) fail(`binding v${item.version} does not supersede the exact prior active head`, "E_BINDING_CHAIN");
    }
  }
  return ordered.at(-1) ?? null;
}

async function currentBinding(root, recordsRoot, role, scope) {
  const canonicalScope = canonicalSessionScopeForRole(role, scope);
  const records = await bindingRecords(root, recordsRoot, role, canonicalScope);
  return validateBindingChain(records, role, canonicalScope);
}

function digestField(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail(`${label} must be a SHA-256 digest`, "E_BINDING_RECORD");
  return value;
}

async function pendingRecords(root, recordsRoot, role, scope) {
  const canonicalScope = canonicalSessionScopeForRole(role, scope);
  const directory = bindingScopeDirectory(recordsRoot, role, canonicalScope);
  let entries;
  try {
    entries = await fs.readdir(absoluteFromRelative(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    let replacementVersion = null;
    if (entry.name === "pending.v1.json") {
      replacementVersion = null;
    } else {
      const match = entry.name.match(/^pending-replacement\.v(\d+)\.json$/i);
      if (!match) continue;
      replacementVersion = Number(match[1]);
      if (entry.name !== `pending-replacement.v${replacementVersion}.json`) fail(`pending replacement filename is not canonically versioned: ${directory}/${entry.name}`, "E_BINDING_RECORD");
    }
    const loaded = await readJsonRecord(root, `${directory}/${entry.name}`, "session binding request");
    const value = loaded.value;
    if (value.schemaVersion !== SESSION_BINDING_REQUEST_SCHEMA || value.lifecycle !== "PENDING") fail(`invalid pending session binding schema: ${loaded.path}`, "E_BINDING_RECORD");
    if (value.publicRole !== role || canonicalSessionScopeForRole(role, value.scope) !== canonicalScope) fail(`pending session binding role/scope contradicts its directory: ${loaded.path}`, "E_BINDING_RECORD");
    if (typeof value.replacement !== "boolean" || value.replacement !== (replacementVersion !== null)) fail(`pending session binding replacement flag contradicts its filename: ${loaded.path}`, "E_BINDING_RECORD");
    assertRelativeInput(value.sourceResultPath, "pending sourceResultPath");
    digestField(value.sourceResultDigest, "pending sourceResultDigest");
    const source = await fileReference(root, value.sourceResultPath, "pending source result evidence");
    if (source.sha256 !== value.sourceResultDigest) fail(`pending source result bytes contradict its digest: ${loaded.path}`, "E_BINDING_RECORD");
    if (value.capsulePath !== null && value.capsulePath !== undefined) assertRelativeInput(value.capsulePath, "pending capsulePath");
    const hasDispatchPath = Object.prototype.hasOwnProperty.call(value, "dispatchRequestPath");
    const hasDispatchDigest = Object.prototype.hasOwnProperty.call(value, "dispatchRequestDigest");
    if (hasDispatchPath !== hasDispatchDigest) fail(`pending dispatch request reference is incomplete: ${loaded.path}`, "E_BINDING_RECORD");
    if (hasDispatchPath) {
      assertRelativeInput(value.dispatchRequestPath, "pending dispatchRequestPath");
      digestField(value.dispatchRequestDigest, "pending dispatchRequestDigest");
    }
    if (value.dispatchIdentityHash !== null && value.dispatchIdentityHash !== undefined) digestField(value.dispatchIdentityHash, "pending dispatchIdentityHash");
    if (replacementVersion !== null) {
      if (value.replacementVersion !== replacementVersion) fail(`pending replacement version contradicts its filename: ${loaded.path}`, "E_BINDING_RECORD");
      const predecessorPath = assertRelativeInput(value.currentBindingPath, "pending currentBindingPath");
      const predecessorDigest = digestField(value.currentBindingDigest, "pending currentBindingDigest");
      const authorization = value.replacementAuthorization;
      if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) fail(`pending replacement authorization is missing: ${loaded.path}`, "E_BINDING_RECORD");
      const authorizationPath = assertRelativeInput(authorization.path, "pending replacement authorization path");
      const authorizationDigest = digestField(authorization.sha256, "pending replacement authorization digest");
      const authorizationFile = await fileReference(root, authorizationPath, "pending replacement authorization evidence");
      if (authorizationFile.sha256 !== authorizationDigest) fail(`pending replacement authorization bytes contradict its digest: ${loaded.path}`, "E_BINDING_RECORD");
      candidates.push({ ...loaded, replacementVersion, predecessorPath, predecessorDigest });
    } else {
      if (value.replacementVersion !== undefined && value.replacementVersion !== null) fail(`initial pending record must not carry a replacement version: ${loaded.path}`, "E_BINDING_RECORD");
      candidates.push({ ...loaded, replacementVersion: null });
    }
  }
  return candidates.sort((left, right) => (left.replacementVersion ?? 0) - (right.replacementVersion ?? 0));
}

function bindingRequestReference(binding) {
  const hasPath = Object.prototype.hasOwnProperty.call(binding.value, "bindingRequestPath");
  const hasDigest = Object.prototype.hasOwnProperty.call(binding.value, "bindingRequestDigest");
  if (hasPath !== hasDigest) fail(`session binding request reference is incomplete: ${binding.path}`, "E_BINDING_CHAIN");
  if (!hasPath) return null;
  return {
    path: assertRelativeInput(binding.value.bindingRequestPath, "bindingRequestPath"),
    digest: digestField(binding.value.bindingRequestDigest, "bindingRequestDigest"),
  };
}

function pendingMatchesBinding(pending, binding) {
  const value = pending.value;
  if (binding.value.scope !== value.scope || binding.value.sessionId !== value.sessionId || binding.value.sourceResultPath !== value.sourceResultPath || binding.value.sourceResultDigest !== value.sourceResultDigest) return false;
  if (value.replacement) {
    return binding.version === value.replacementVersion
      && binding.value.supersedes === value.currentBindingDigest
      && stableJson(binding.value.replacementAuthorization ?? null) === stableJson(value.replacementAuthorization ?? null);
  }
  return binding.version === 1 && (binding.value.supersedes ?? null) === null;
}

async function bindingState(root, recordsRoot, role, scope) {
  const canonicalScope = canonicalSessionScopeForRole(role, scope);
  const records = await bindingRecords(root, recordsRoot, role, canonicalScope);
  const current = validateBindingChain(records, role, canonicalScope);
  const requests = await pendingRecords(root, recordsRoot, role, canonicalScope);
  const recordsByPath = new Map(records.map((record) => [record.path, record]));
  for (const pending of requests) {
    if (!pending.value.replacement) continue;
    const predecessor = recordsByPath.get(pending.predecessorPath);
    if (!predecessor || predecessor.digest !== pending.predecessorDigest || predecessor.version !== pending.replacementVersion - 1) {
      fail(`pending replacement predecessor path/digest is dangling or does not match its version: ${pending.path}`, "E_BINDING_CHAIN");
    }
  }
  const byPath = new Map(requests.map((pending) => [pending.path, pending]));
  const resolved = new Set();
  for (const binding of records) {
    const reference = bindingRequestReference(binding);
    if (!reference) continue;
    const pending = byPath.get(reference.path);
    if (!pending) fail(`session binding references a missing pending request: ${binding.path}`, "E_BINDING_CHAIN");
    if (reference.digest !== pending.digest) fail(`session binding request digest does not match the referenced pending record: ${binding.path}`, "E_BINDING_CHAIN");
    if (resolved.has(pending.path) || !pendingMatchesBinding(pending, binding)) fail(`session binding does not preserve the exact pending request evidence: ${binding.path}`, "E_BINDING_CHAIN");
    resolved.add(pending.path);
  }
  const unresolved = requests.filter((pending) => !resolved.has(pending.path));
  if (unresolved.length > 1) fail("multiple unresolved pending replacement/session binding records are stale, forked, or contradictory for one role/scope", "E_BINDING_CHAIN");
  const active = unresolved[0] ?? null;
  if (active) {
    if (!current) {
      if (active.value.replacement) fail("a replacement pending record requires a current binding", "E_BINDING_CHAIN");
    } else if (!active.value.replacement) {
      fail("the original pending request remains unresolved after a binding exists", "E_BINDING_CHAIN");
    } else if (active.replacementVersion !== current.version + 1 || active.predecessorPath !== current.path || active.predecessorDigest !== current.digest) {
      fail("pending replacement is stale, forked, or skips the next binding version", "E_BINDING_CHAIN");
    }
  }
  return { records, current, requests, resolved, unresolved, active };
}

async function pendingBinding(root, recordsRoot, role, scope, { replacement = false, version = null } = {}) {
  const state = await bindingState(root, recordsRoot, role, scope);
  const pending = state.active;
  if (!pending) return null;
  if (pending.value.replacement !== replacement) fail("the requested binding operation does not match the unresolved pending request", "E_BINDING_PENDING");
  if (replacement && version !== null && pending.replacementVersion !== version) fail("requested pending replacement version is not the next numeric version", "E_BINDING_CHAIN");
  return pending;
}

function pendingDispatchPath(pending) {
  if (pending.value.dispatchRequestPath !== undefined && pending.value.dispatchRequestPath !== null) {
    return assertRelativeInput(pending.value.dispatchRequestPath, "pending dispatchRequestPath");
  }
  const sourcePath = assertRelativeInput(pending.value.sourceResultPath, "pending sourceResultPath");
  if (!sourcePath.endsWith("/result.json")) fail(`pending source result does not identify a runtime dispatch result: ${pending.path}`, "E_BINDING_CHAIN");
  return `${sourcePath.slice(0, -"result.json".length)}dispatch-request.v1.json`;
}

async function pendingDispatchRequest(root, pending) {
  const requestPath = pendingDispatchPath(pending);
  const request = await readJsonRecord(root, requestPath, "pending dispatch request");
  if (pending.value.dispatchRequestDigest !== undefined && pending.value.dispatchRequestDigest !== null) {
    const expectedDigest = digestField(pending.value.dispatchRequestDigest, "pending dispatchRequestDigest");
    if (request.digest !== expectedDigest) fail(`pending dispatch request digest does not match the referenced request: ${pending.path}`, "E_BINDING_CHAIN");
  }
  if (request.value.schemaVersion !== DISPATCH_REQUEST_SCHEMA
    || request.value.publicRole !== pending.value.publicRole
    || request.value.sessionScope !== pending.value.scope
    || request.value.resultPath !== pending.value.sourceResultPath) {
    fail(`pending dispatch request is not the complete immutable request for ${pending.path}`, "E_BINDING_CHAIN");
  }
  return request;
}

async function rawResultForDispatch(root, resultPath) {
  const loaded = await readJsonRecord(root, resultPath, "provider result");
  if (!loaded.value || typeof loaded.value !== "object" || Array.isArray(loaded.value)) fail("provider result must be a JSON object", "E_RESULT_RECORD");
  return loaded;
}

async function attemptDirectories(root, recordsRoot, jobKey) {
  const relative = runtimePath(recordsRoot, `jobs/${jobKey}`);
  const absolute = absoluteFromRelative(root, relative);
  try {
    await assertNoReparseCrossing(root, relative, { allowMissing: false, includeFinal: true });
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^attempt-(\d+)$/i);
      if (!match) continue;
      const attempt = Number(match[1]);
      const requestPath = `${relative}/${entry.name}/dispatch-request.v1.json`;
      const request = await readJsonIfPresent(root, requestPath, "dispatch request");
      if (request) result.push({ attempt, request, relative: `${relative}/${entry.name}` });
    }
    const ordered = result.sort((left, right) => left.attempt - right.attempt);
    for (let index = 0; index < ordered.length; index += 1) {
      if (ordered[index].attempt !== index + 1) fail("physical attempt sequence is skipped, duplicated, or arbitrarily numbered", "E_ATTEMPT_SEQUENCE");
    }
    return ordered;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function loadEnvelope(root, options) {
  const sourceFile = options.adapterEnvelopePath ?? options.adapterEnvelopeSourceFile ?? null;
  if (sourceFile !== null) {
    const loaded = await loadAdapterEnvelopeFile(root, sourceFile);
    if (loaded.sourceError) return { valid: false, error: loaded.sourceError, sourceFile: loaded.sourceFile, sourceFileDigest: loaded.sourceFileDigest };
    return { valid: true, adapterEnvelope: loaded.adapterEnvelope, sourceFile: loaded.sourceFile, sourceFileDigest: loaded.sourceFileDigest };
  }
  if (!options.adapterEnvelope || typeof options.adapterEnvelope !== "object" || Array.isArray(options.adapterEnvelope)) {
    return { valid: false, error: "a dd.adapter-envelope.v1 object or project-relative envelope file is required", sourceFile: null, sourceFileDigest: null };
  }
  return { valid: true, adapterEnvelope: options.adapterEnvelope, sourceFile: null, sourceFileDigest: null };
}

async function bindingConfirmation(root, recordsRoot, publicRole, options = {}) {
  const role = roleName(publicRole);
  const scope = canonicalSessionScopeForRole(role, options.scope);
  const sessionId = requiredText(options.sessionId ?? options.observedSessionId, "sessionId", 512);
  const sourceResultPath = assertRelativeInput(options.sourceResultPath ?? options.resultPath, "sourceResultPath");
  const source = await rawResultForDispatch(root, sourceResultPath);
  const sourceDigest = sha256Bytes(source.bytes);
  const suppliedDigest = options.sourceResultDigest ?? options.resultDigest ?? null;
  if (suppliedDigest !== null && sourceDigest !== suppliedDigest) fail("binding source result digest does not match the supplied evidence", "E_BINDING_SOURCE");
  const observed = [...new Set(extractSessionRefs(source.value).map((item) => item.value).filter((value) => value.length > 0))];
  const confirmedBy = requiredText(options.confirmedBy ?? options.confirmer, "confirmedBy", 256);
  const confirmationSource = requiredText(options.confirmationSource ?? "explicit-caller", "confirmationSource", 256);
  const replacementRequested = options.replaceSession === true;
  let replacementAuthorizationEvidence = null;
  if (replacementRequested) {
    const authorizationPath = assertRelativeInput(options.replacementAuthorizationPath ?? options.replacementAuthorizationFile, "replacement authorization path");
    const authorizationDigest = requiredText(options.replacementAuthorizationDigest ?? options.replacementDigest, "replacement authorization digest", 128);
    if (!/^[a-f0-9]{64}$/i.test(authorizationDigest)) fail("replacement authorization digest must be SHA-256", "E_BINDING_REPLACEMENT");
    const authorization = await fileReference(root, authorizationPath, "replacement authorization evidence");
    if (authorization.sha256 !== authorizationDigest) fail("replacement authorization digest does not match the current evidence", "E_BINDING_REPLACEMENT");
    replacementAuthorizationEvidence = { path: authorizationPath, sha256: authorizationDigest };
  }
  const requestedReplacementVersion = options.replacementVersion === undefined || options.replacementVersion === null ? null : options.replacementVersion;
  if (requestedReplacementVersion !== null && (!Number.isInteger(requestedReplacementVersion) || requestedReplacementVersion < 2)) fail("replacementVersion must be a positive binding version", "E_BINDING_CHAIN");
  const state = await bindingState(root, recordsRoot, role, scope);
  const pending = state.active;
  const resolvedCandidates = [];
  for (const binding of state.records) {
    const reference = bindingRequestReference(binding);
    if (!reference) continue;
    const candidate = state.requests.find((request) => request.path === reference.path && request.digest === reference.digest);
    if (candidate && pendingMatchesBinding(candidate, binding)) resolvedCandidates.push({ binding, pending: candidate });
  }
  const matchesConfirmation = (binding, candidate) => {
    const expectedProvider = options.provider === undefined ? candidate.value.provider : options.provider;
    const expectedVersion = requestedReplacementVersion ?? candidate.replacementVersion;
    return candidate.value.replacement === replacementRequested
      && binding.value.publicRole === role
      && binding.value.scope === scope
      && binding.value.sessionId === sessionId
      && binding.value.sourceResultPath === sourceResultPath
      && binding.value.sourceResultDigest === sourceDigest
      && binding.value.confirmedBy === confirmedBy
      && binding.value.confirmationSource === confirmationSource
      && binding.value.provider === expectedProvider
      && (replacementRequested
        ? binding.version === expectedVersion
          && stableJson(binding.value.replacementAuthorization ?? null) === stableJson(replacementAuthorizationEvidence)
          && stableJson(candidate.value.replacementAuthorization ?? null) === stableJson(replacementAuthorizationEvidence)
        : binding.version === 1 && (binding.value.supersedes ?? null) === null);
  };
  if (!pending) {
    const exact = resolvedCandidates.find(({ binding, pending: candidate }) => matchesConfirmation(binding, candidate));
    if (exact) return { status: "REUSED", path: exact.binding.path, digest: exact.binding.digest, record: exact.binding.value, reused: true };
    if (state.records.length > 0) fail(`existing session binding for ${role} contradicts the requested confirmation`, "E_BINDING_CONFIRMATION");
    fail(`no pending session binding request exists for ${role}`, "E_BINDING_PENDING");
  }
  if (pending.value.replacement !== replacementRequested) fail("replacement binding requires explicit replaceSession=true", "E_BINDING_REPLACEMENT");
  if (replacementRequested && requestedReplacementVersion !== null && pending.replacementVersion !== requestedReplacementVersion) fail("requested pending replacement version is not the next numeric version", "E_BINDING_CHAIN");
  if (sourceDigest !== pending.value.sourceResultDigest || pending.value.sourceResultPath !== sourceResultPath) fail("binding source result path or digest does not match the pending request", "E_BINDING_SOURCE");
  if (observed.length !== 1 || observed[0] !== sessionId || sessionId !== pending.value.sessionId) fail("binding requires exactly one observed session ID matching the pending request", "E_BINDING_SESSION");
  const existing = state.current;
  const replacement = pending.value.replacement === true;
  if (replacement !== replacementRequested) fail("replacement binding requires explicit replaceSession=true", "E_BINDING_REPLACEMENT");
  if (pending.value.scope !== scope) fail("pending binding scope does not match the requested scope", "E_BINDING_SCOPE");
  if (replacement) {
    if (pending.value.replacementAuthorization?.path !== replacementAuthorizationEvidence.path || pending.value.replacementAuthorization?.sha256 !== replacementAuthorizationEvidence.sha256) fail("replacement authorization evidence path or digest does not match the pending request", "E_BINDING_REPLACEMENT");
    if (!existing || pending.value.currentBindingPath !== existing.path || pending.value.currentBindingDigest !== existing.digest) fail("replacement binding does not reference the current role/scope binding", "E_BINDING_REPLACEMENT");
  } else if (existing && existing.value.sessionId !== sessionId) {
    fail("session replacement requires an explicit replacement dispatch and evidence", "E_BINDING_REPLACEMENT");
  }
  const provider = requiredText(options.provider ?? pending.value.provider, "provider", 256);
  if (options.provider !== undefined && provider !== pending.value.provider) fail("binding provider contradicts the pending request", "E_BINDING_CONFIRMATION");
  const version = (existing?.version ?? 0) + 1;
  const record = {
    schemaVersion: SESSION_BINDING_SCHEMA,
    version,
    lifecycle: "BOUND",
    publicRole: role,
    controllerRole: CONTROLLER_ROLES[role],
    scope,
    sessionId,
    provider,
    sourceResultPath,
    sourceResultDigest: sourceDigest,
    bindingRequestPath: pending.path,
    bindingRequestDigest: pending.digest,
    dispatchIdentityHash: pending.value.dispatchIdentityHash ?? null,
    confirmedBy,
    confirmationSource,
    supersedes: existing?.digest ?? null,
    ...(replacement ? { replacementAuthorization: pending.value.replacementAuthorization } : {}),
  };
  return writeImmutableRecord(root, bindingPath(role, scope, version, recordsRoot), record).then((written) => ({ ...written, record }));
}

export async function confirmSessionBinding(options = {}) {
  const root = await realDirectory(options.root, "root");
  const recordsRoot = recordsRootValue(options.recordsRoot);
  const role = roleName(options.role);
  const result = await bindingConfirmation(root, recordsRoot, role, options);
  if (result.status === "STOPPED_VERBATIM_TOO_LARGE") return result;
  if (!result.reused) {
    await recordEvent({
      root,
      recordsRoot,
      eventType: "session_bound",
      references: [{ path: result.path, sha256: result.digest }],
      data: { publicRole: role, scope: result.record.scope, sessionId: result.record.sessionId, version: result.record.version, replacementAuthorization: result.record.replacementAuthorization ?? null },
    });
  }
  return { ...result, runtimeStatus: "RESULT_READY_FOR_PLANNING_LEAD" };
}

export const bindSession = confirmSessionBinding;

export async function inspectSessionBindings({ root, recordsRoot = DEFAULT_RECORDS_ROOT, role } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const normalizedRecordsRoot = recordsRootValue(recordsRoot);
  const roles = role ? [roleName(role)] : [...PUBLIC_ROLES];
  const result = [];
  for (const publicRole of roles) {
    const records = await bindingRecords(projectRoot, normalizedRecordsRoot, publicRole);
    const scopeNames = new Set(records.map((item) => item.value.scope));
    const roleRelative = bindingRoleDirectory(normalizedRecordsRoot, publicRole);
    try {
      const scopeEntries = await fs.readdir(absoluteFromRelative(projectRoot, roleRelative), { withFileTypes: true });
      for (const entry of scopeEntries) {
        if (entry.isDirectory()) {
          const scopeRecords = records.filter((item) => item.path.startsWith(`${roleRelative}/${entry.name}/`));
          for (const item of scopeRecords) scopeNames.add(item.value.scope);
          const scopeRelative = `${roleRelative}/${entry.name}`;
          const pendingEntries = await fs.readdir(absoluteFromRelative(projectRoot, scopeRelative), { withFileTypes: true });
          for (const pendingEntry of pendingEntries) {
            if (!pendingEntry.isFile() || !/^(?:pending\.v1|pending-replacement\.v\d+)\.json$/i.test(pendingEntry.name)) continue;
            const pending = await readJsonRecord(projectRoot, `${scopeRelative}/${pendingEntry.name}`, "session binding request");
            if (typeof pending.value.scope === "string") scopeNames.add(pending.value.scope);
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const scopes = [];
    for (const scope of [...scopeNames].sort()) {
      const state = await bindingState(projectRoot, normalizedRecordsRoot, publicRole, scope);
      const pending = state.active?.value.replacement ? null : state.active;
      const replacementPending = state.active?.value.replacement ? state.active : null;
      scopes.push({
        scope,
        pending: pending ? { path: pending.path, digest: pending.digest, record: pending.value } : null,
        replacementPending: replacementPending ? { path: replacementPending.path, digest: replacementPending.digest, record: replacementPending.value } : null,
        bindings: state.records.map((item) => ({ version: item.version, path: item.path, digest: item.digest, record: item.value })),
      });
    }
    result.push({
      publicRole,
      scopes,
      pending: scopes.length === 1 ? scopes[0].pending : null,
      bindings: scopes.flatMap((scopeEntry) => scopeEntry.bindings),
    });
  }
  return result;
}

async function pendingBindingForStatus(root, recordsRoot) {
  const bindings = await inspectSessionBindings({ root, recordsRoot });
  return bindings.flatMap((entry) => entry.scopes.flatMap((scope) => {
    const pendingItems = [scope.pending, scope.replacementPending].filter(Boolean);
    return pendingItems.map((pending) => ({ publicRole: entry.publicRole, scope: scope.scope, pending }));
  }));
}

function acknowledgementPath(recordsRoot, capsulePath) {
  return runtimePath(recordsRoot, `acknowledgements/${sha256Bytes(capsulePath)}.json`);
}

async function acknowledgedCapsule(root, recordsRoot, capsulePath, capsuleDigest) {
  const relative = acknowledgementPath(recordsRoot, capsulePath);
  const acknowledgement = await readJsonIfPresent(root, relative, "result acknowledgement");
  if (!acknowledgement) return null;
  if (acknowledgement.value.schemaVersion !== RESULT_ACKNOWLEDGEMENT_SCHEMA || acknowledgement.value.capsulePath !== capsulePath || acknowledgement.value.capsuleDigest !== capsuleDigest) {
    fail(`result acknowledgement contradicts its capsule: ${relative}`, "E_ACKNOWLEDGEMENT_CONTRADICTION");
  }
  return acknowledgement;
}

async function latestCapsuleForStatus(root, recordsRoot, { jobKey = null, phaseKey = null, workPackageKey = null } = {}) {
  if (!jobKey) return null;
  const normalizedJobKey = assertRelativeInput(jobKey, "jobKey");
  const jobsRelative = runtimePath(recordsRoot, `jobs/${normalizedJobKey}`);
  const jobsAbsolute = absoluteFromRelative(root, jobsRelative);
  let entries;
  try {
    await assertNoReparseCrossing(root, jobsRelative, { allowMissing: false, includeFinal: true });
    entries = await fs.readdir(jobsAbsolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const attempts = entries.filter((entry) => entry.isDirectory() && /^attempt-\d+$/i.test(entry.name)).map((entry) => ({ entry, attempt: Number(entry.name.match(/^attempt-(\d+)$/i)[1]) })).sort((a, b) => b.attempt - a.attempt);
  if (attempts.length > 64) fail("status attempt scan exceeded its hard bound", "STOPPED_STATUS_SCAN_BOUND");
  for (const attemptInfo of attempts) {
    const attemptEntry = attemptInfo.entry;
    const attemptRelative = `${jobsRelative}/${attemptEntry.name}`;
    const request = await readJsonIfPresent(root, `${attemptRelative}/dispatch-request.v1.json`, "dispatch request");
    if (!request) continue;
    if (phaseKey !== null && request.value.phaseKey !== phaseKey) continue;
    if (workPackageKey !== null && request.value.workPackageKey !== workPackageKey) continue;
    const capsulePath = `${attemptRelative}/controller/capsule.v1.json`;
    const raw = await readJsonIfPresent(root, capsulePath, "result capsule");
    if (!raw) continue;
    const validation = await validateResultCapsule(raw.value, { root, verifyRaw: true });
    if (!validation.valid || raw.value.terminal !== true || raw.value.capsuleStatus !== "TERMINAL") continue;
    const acknowledgement = await acknowledgedCapsule(root, recordsRoot, capsulePath, raw.digest);
    if (acknowledgement) return { acknowledged: true, path: capsulePath, sha256: raw.digest, acknowledgement: { path: acknowledgement.path, sha256: acknowledgement.digest } };
    return { acknowledged: false, path: capsulePath, sha256: raw.digest, capsule: raw.value };
  }
  return null;
}

export async function acknowledgeResult({ root, recordsRoot = DEFAULT_RECORDS_ROOT, capsulePath, acknowledgementSourcePath, acknowledgementFile, acknowledgementSourceDigest, sourceDigest, acknowledgedBy = "Planning Lead" } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const normalizedRecordsRoot = recordsRootValue(recordsRoot);
  const capsuleRelative = assertRelativeInput(capsulePath, "capsule path");
  const capsuleBytes = await readOwnedFile(projectRoot, capsuleRelative, "result capsule");
  let capsule;
  try {
    capsule = JSON.parse(capsuleBytes.toString("utf8"));
  } catch (error) {
    fail(`malformed result capsule: ${error.message}`, "E_ACK_CAPSULE");
  }
  const validation = await validateResultCapsule(capsule, { root: projectRoot, verifyRaw: true });
  if (!validation.valid || capsule.terminal !== true || capsule.capsuleStatus !== "TERMINAL") fail("only a valid terminal result capsule can be acknowledged", "E_ACK_CAPSULE");
  const sourcePath = assertRelativeInput(acknowledgementSourcePath ?? acknowledgementFile, "acknowledgement source path");
  const source = await fileReference(projectRoot, sourcePath, "acknowledgement source");
  const expectedSourceDigest = acknowledgementSourceDigest ?? sourceDigest;
  if (expectedSourceDigest !== undefined && expectedSourceDigest !== source.sha256) fail("acknowledgement source digest does not match the current file bytes", "E_ACK_SOURCE");
  const record = {
    schemaVersion: RESULT_ACKNOWLEDGEMENT_SCHEMA,
    lifecycle: "ACKNOWLEDGED",
    capsulePath: capsuleRelative,
    capsuleDigest: sha256Bytes(capsuleBytes),
    acknowledgementSourcePath: source.path,
    acknowledgementSourceDigest: source.sha256,
    acknowledgedBy: requiredText(acknowledgedBy, "acknowledgedBy", 256),
    meaning: "Planning Lead handled this result; no approval or authority is implied",
  };
  const relative = acknowledgementPath(normalizedRecordsRoot, capsuleRelative);
  const written = await writeImmutableRecord(projectRoot, relative, record);
  if (written.path && written.digest) await recordEvent({ root: projectRoot, recordsRoot: normalizedRecordsRoot, eventType: "result_acknowledged", references: [{ path: written.path, sha256: written.digest }, { path: capsuleRelative, sha256: record.capsuleDigest }, { path: source.path, sha256: source.sha256 }], data: { capsulePath: capsuleRelative } });
  return { ...written, record, runtimeStatus: "READY_FOR_AUTHORIZED_DISPATCH" };
}

export async function runtimeStatus({ root, recordsRoot = DEFAULT_RECORDS_ROOT, phaseKey = null, workPackageKey = null, jobKey = null } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const normalizedRecordsRoot = recordsRootValue(recordsRoot);
  try {
    if (workPackageKey !== null && workPackageKey !== undefined && (phaseKey === null || phaseKey === undefined)) fail("workPackageKey requires phaseKey", "E_RUNTIME_SCOPE");
    const normalizedPhaseKey = phaseKey === null || phaseKey === undefined ? null : requiredText(phaseKey, "phaseKey", 256);
    const normalizedWorkPackageKey = workPackageKey === null || workPackageKey === undefined ? null : requiredText(workPackageKey, "workPackageKey", 256);
    const config = await deriveActiveConfiguration({ root: projectRoot, recordsRoot: normalizedRecordsRoot });
    if (config.status !== "CONFIRMED" || !config.active) {
      return {
        schemaVersion: STATUS_SCHEMA,
        status: "AWAITING_CONFIGURATION_CONFIRMATION",
        nextActor: "Planning Lead",
        records: config.active ? [{ path: config.active.configurationPath, sha256: config.active.configurationDigest }] : [],
        reason: "a confirmed non-conflicting project configuration is required",
      };
    }
    const questions = await listQuestions({ root: projectRoot, recordsRoot: normalizedRecordsRoot });
    const open = applicableQuestions(questions, { phaseKey: normalizedPhaseKey, workPackageKey: normalizedWorkPackageKey });
    if (open.length > 0) {
      return {
        schemaVersion: STATUS_SCHEMA,
        status: "AWAITING_HUMAN_ANSWER",
        nextActor: "user",
        records: open.slice(0, 32).flatMap((question) => Object.values(question.records)),
        omittedCount: Math.max(0, open.length - 32),
        configuration: { path: config.active.configurationPath, sha256: config.active.configurationDigest },
      };
    }
    const pending = await pendingBindingForStatus(projectRoot, normalizedRecordsRoot);
    const relevantScopes = normalizedPhaseKey === null ? null : new Set([
      "project",
      deriveSessionScope("planner-2", { continuityPolicy: "phase_scoped" }, { phaseKey: normalizedPhaseKey, workPackageKey: normalizedWorkPackageKey ?? "status" }),
      ...(normalizedWorkPackageKey === null ? [] : [deriveSessionScope("executor", { sessionScope: "work_package_scoped" }, { phaseKey: normalizedPhaseKey, workPackageKey: normalizedWorkPackageKey })]),
    ]);
    const relevantPending = pending.filter((item) => relevantScopes === null || relevantScopes.has(item.scope));
    if (relevantPending.length > 0) {
      return {
        schemaVersion: STATUS_SCHEMA,
        status: "AWAITING_SESSION_BINDING",
        nextActor: "Planning Lead",
        records: relevantPending.slice(0, 32).map((item) => item.pending),
        omittedCount: Math.max(0, relevantPending.length - 32),
        configuration: { path: config.active.configurationPath, sha256: config.active.configurationDigest },
      };
    }
    const latestCapsule = await latestCapsuleForStatus(projectRoot, normalizedRecordsRoot, { jobKey, phaseKey: normalizedPhaseKey, workPackageKey: normalizedWorkPackageKey });
    if (latestCapsule) {
      if (latestCapsule.acknowledged) {
        return {
          schemaVersion: STATUS_SCHEMA,
          status: "READY_FOR_AUTHORIZED_DISPATCH",
          nextActor: "Planning Lead",
          records: [{ path: latestCapsule.path, sha256: latestCapsule.sha256 }, latestCapsule.acknowledgement],
          configuration: { path: config.active.configurationPath, sha256: config.active.configurationDigest },
          reason: "the terminal result was mechanically acknowledged; acknowledgement is not approval",
        };
      }
      return {
        schemaVersion: STATUS_SCHEMA,
        status: "RESULT_READY_FOR_PLANNING_LEAD",
        nextActor: "Planning Lead",
        records: [{ path: latestCapsule.path, sha256: latestCapsule.sha256 }],
        configuration: { path: config.active.configurationPath, sha256: config.active.configurationDigest },
      };
    }
    return {
      schemaVersion: STATUS_SCHEMA,
      status: "READY_FOR_AUTHORIZED_DISPATCH",
      nextActor: "Planning Lead",
      records: [{ path: config.active.configurationPath, sha256: config.active.configurationDigest }],
      configurationVersion: config.active.version,
    };
  } catch (error) {
    return {
      schemaVersion: STATUS_SCHEMA,
      status: "STOPPED",
      nextActor: "user",
      records: [],
      reason: error.message,
      code: error.code ?? "E_RUNTIME",
    };
  }
}

async function readBrief(root, briefPath) {
  const relative = assertRelativeInput(briefPath, "brief path");
  const bytes = await readOwnedFile(root, relative, "brief");
  if (bytes.length === 0) fail("brief must not be empty", "E_BRIEF");
  return { path: relative, digest: sha256Bytes(bytes), bytes };
}

function dispatchRequestIdentity({ publicRole, controllerRole, jobKey, attempt, attemptKind, correctionOrdinal, attemptAuthorization, purpose, phaseKey, workPackageKey, sessionScope, brief, configuration, binding, roleProfile, adapterIdentifier, adapter, providerFamily, args, invocationContractDigest: contractDigest, resultPath, artifactDir, envelope, sourceFile, sourceFileDigest, expectedSession, waitPath, timeoutMs, context, replacement }) {
  return {
    schemaVersion: DISPATCH_REQUEST_SCHEMA,
    publicRole,
    controllerRole,
    jobKey,
    attempt,
    attemptKind,
    correctionOrdinal,
    attemptAuthorization: attemptAuthorization ?? null,
    purpose,
    phaseKey,
    workPackageKey,
    sessionScope,
    briefPath: brief.path,
    briefDigest: brief.digest,
    configurationPath: configuration.configurationPath,
    configurationDigest: configuration.configurationDigest,
    roleProfile,
    bindingPath: binding?.path ?? null,
    bindingDigest: binding?.digest ?? null,
    adapterIdentifier,
    adapter,
    providerFamily,
    invocationContractDigest: contractDigest ?? null,
    argsDigest: sha256Bytes(stableJson(args)),
    resultPath,
    artifactDir,
    envelopeDigest: sha256Bytes(stableJson(envelope)),
    envelopeSourceFile: sourceFile,
    envelopeSourceDigest: sourceFileDigest,
    expectedSession,
    waitPath,
    timeoutMs: timeoutMs ?? null,
    contextManagement: context,
    replacement: replacement ?? null,
  };
}

function sameRequest(left, right) {
  return stableJson(left) === stableJson(right);
}

const CONTINUATION_IDENTITY_FIELDS = Object.freeze([
  "schemaVersion",
  "publicRole",
  "controllerRole",
  "jobKey",
  "purpose",
  "phaseKey",
  "workPackageKey",
  "sessionScope",
  "briefPath",
  "briefDigest",
  "configurationPath",
  "configurationDigest",
  "adapterIdentifier",
  "adapter",
  "providerFamily",
  "envelopeDigest",
  "envelopeSourceFile",
  "envelopeSourceDigest",
  "waitPath",
  "timeoutMs",
  "contextManagement",
  "replacement",
]);

function sameContinuationIdentity(left, right) {
  return CONTINUATION_IDENTITY_FIELDS.every((field) => stableJson(left?.[field]) === stableJson(right?.[field]));
}

async function dispatchStop(options, code, reason, data = {}) {
  const stop = await stopRecord({ ...options, code, reason, data });
  const eventType = code === "STOPPED_INVALID_ENVELOPE" ? "envelope_rejected" : "stop_recorded";
  const references = stop.digest ? [{ path: stop.stopPath, sha256: stop.digest }] : [];
  await recordEvent({ root: options.root, recordsRoot: options.recordsRoot, eventType, references, data: { code: stop.stopCode ?? code, reason } });
  return stop;
}

function dispatchContext(options) {
  const phaseKey = requiredText(options.phaseKey, "phaseKey", 256);
  const workPackageKey = requiredText(options.workPackageKey, "workPackageKey", 256);
  return { phaseKey, workPackageKey };
}

export function deriveSessionScope(publicRole, roleConfig, { phaseKey, workPackageKey }) {
  const role = roleName(publicRole);
  const keys = {
    phaseKey: requiredText(phaseKey, "phaseKey", 256),
    workPackageKey: requiredText(workPackageKey, "workPackageKey", 256),
  };
  if (role === "planner-2") {
    if (roleConfig.continuityPolicy === "phase_scoped") return canonicalSessionScopeForRole(role, `phase:${scopeComponent(keys.phaseKey, "phaseKey")}`);
    if (roleConfig.continuityPolicy === "project_scoped") return "project";
    fail("planner2.continuityPolicy is unsupported", "E_SESSION_SCOPE");
  }
  if (roleConfig.sessionScope === "work_package_scoped") return canonicalSessionScopeForRole(role, `work-package:${scopeComponent(keys.phaseKey, "phaseKey")}/${scopeComponent(keys.workPackageKey, "workPackageKey")}`);
  fail("executor.sessionScope is unsupported", "E_SESSION_SCOPE");
}

const ATTEMPT_KINDS = Object.freeze(["initial", "correction", "technical_replay"]);

function activeRoleProfile(publicRole, roleConfig, options) {
  const fields = publicRole === "planner-2"
    ? ["adapterIdentifier", "providerFamily", "modelLabel", "effort", "permissionProfile", "continuityPolicy", "sessionMode"]
    : ["adapterIdentifier", "providerFamily", "modelLabel", "effort", "permissionProfile", "noCommit", "sessionScope"];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(options, field) && options[field] !== undefined && stableJson(options[field]) !== stableJson(roleConfig[field])) {
      fail(`caller ${field} contradicts the confirmed ${publicRole} role profile`, "E_CONFIGURATION_PROFILE_CONTRADICTION");
    }
  }
  return Object.fromEntries(fields.map((field) => [field, roleConfig[field]]));
}

function attemptKind(value) {
  if (!ATTEMPT_KINDS.includes(value)) fail(`attemptKind must be one of: ${ATTEMPT_KINDS.join(", ")}`, "E_ATTEMPT_KIND");
  return value;
}

async function attemptAuthorization(root, options, kind) {
  const authorizationPath = options.attemptAuthorizationPath
    ?? options.attemptAuthorizationFile
    ?? options.authorizationPath
    ?? options.authorizationFile
    ?? (kind === "correction" ? options.correctionAuthorizationPath : options.replayAuthorizationPath);
  const authorizationDigest = options.attemptAuthorizationDigest
    ?? options.attemptDigest
    ?? options.authorizationDigest
    ?? (kind === "correction" ? options.correctionAuthorizationDigest : options.replayAuthorizationDigest);
  if (authorizationPath === undefined || authorizationDigest === undefined) fail(`${kind} requires immutable authorization path and SHA-256 digest`, "E_ATTEMPT_AUTHORIZATION");
  const relative = assertRelativeInput(authorizationPath, `${kind} authorization path`);
  const digest = requiredText(authorizationDigest, `${kind} authorization digest`, 128);
  if (!/^[a-f0-9]{64}$/i.test(digest)) fail(`${kind} authorization digest must be SHA-256`, "E_ATTEMPT_AUTHORIZATION");
  const evidence = await fileReference(root, relative, `${kind} authorization evidence`);
  if (evidence.sha256 !== digest) fail(`${kind} authorization digest does not match the current file bytes`, "E_ATTEMPT_AUTHORIZATION");
  return evidence;
}

async function qualifyingTransportFailure(root, previous) {
  const capsulePath = `${previous.relative}/controller/capsule.v1.json`;
  const capsule = await readJsonIfPresent(root, capsulePath, "technical replay capsule");
  if (!capsule || capsule.value?.terminal !== true || capsule.value?.capsuleStatus !== "TERMINAL" || capsule.value?.transportStatus !== "FAILED") return { qualified: false, capsule: null };
  const validation = await validateResultCapsule(capsule.value, { root, verifyRaw: true });
  if (!validation.valid) return { qualified: false, capsule };
  return { qualified: true, capsule };
}

function replayIdentityMatches(previous, current) {
  const fields = [
    "publicRole",
    "controllerRole",
    "jobKey",
    "purpose",
    "phaseKey",
    "workPackageKey",
    "sessionScope",
    "briefPath",
    "briefDigest",
    "configurationPath",
    "configurationDigest",
    "adapterIdentifier",
    "providerFamily",
    "roleProfile",
    "adapter",
    "invocationContractDigest",
    "envelopeDigest",
    "envelopeSourceFile",
    "envelopeSourceDigest",
  ];
  return fields.every((field) => stableJson(previous?.[field]) === stableJson(current?.[field]));
}

async function validateAttemptPolicy({ root, config, existingAttempts, current, options, jobKey }) {
  const explicitAttempt = options.attempt !== undefined;
  const requestedKind = options.attemptKind ?? (existingAttempts.length === 0 ? "initial" : null);
  if (requestedKind === null) return { stop: { code: "STOPPED_ATTEMPT_KIND_REQUIRED", reason: "every non-initial attempt requires an explicit attemptKind" } };
  let kind;
  try {
    kind = attemptKind(requestedKind);
  } catch (error) {
    return { stop: { code: "STOPPED_ATTEMPT_KIND_REQUIRED", reason: error.message } };
  }
  const latestPhysicalAttempt = existingAttempts.at(-1)?.attempt ?? 0;
  let attempt = explicitAttempt ? options.attempt : latestPhysicalAttempt + 1;
  try { padAttempt(attempt); } catch (error) { return { stop: { code: "STOPPED_ATTEMPT_POLICY", reason: error.message } }; }
  const existingForAttempt = explicitAttempt ? existingAttempts.find((entry) => entry.attempt === attempt) : null;
  const recordedKind = existingForAttempt?.request.value.attemptKind ?? null;
  const sameCorrectionOrdinal = requestedKind !== "correction" || existingForAttempt?.request.value.correctionOrdinal === options.correctionOrdinal;
  const reuseCandidate = Boolean(existingForAttempt && recordedKind === requestedKind && sameCorrectionOrdinal);
  if (kind === "initial") {
    if (reuseCandidate) return { attempt, attemptKind: kind, correctionOrdinal: null, authorization: null, previous: null, reuseCandidate: true };
    if (existingAttempts.length !== 0 || attempt !== 1) return { stop: { code: "STOPPED_ATTEMPT_POLICY", reason: "initial is allowed only for the first substantive attempt" } };
    return { attempt, attemptKind: kind, correctionOrdinal: null, authorization: null, previous: null };
  }
  let authorization;
  try {
    authorization = await attemptAuthorization(root, options, kind);
  } catch (error) {
    return { stop: { code: "STOPPED_ATTEMPT_AUTHORIZATION", reason: error.message } };
  }
  if (kind === "correction") {
    const ordinal = options.correctionOrdinal;
    const maxCorrections = config.active.configuration.answers.correctionPolicy.maxCorrections;
    if (!Number.isInteger(ordinal) || ordinal < 1) return { stop: { code: "STOPPED_CORRECTION_POLICY", reason: "correctionOrdinal must be a positive integer" } };
    if (!Number.isInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > ABSOLUTE_CORRECTION_CEILING) return { stop: { code: "STOPPED_CORRECTION_POLICY", reason: "configured correction policy exceeds the absolute ceiling" } };
    if (ordinal > maxCorrections) return { stop: { code: "STOPPED_CORRECTION_LIMIT", reason: `correction ordinal ${ordinal} exceeds configured maxCorrections ${maxCorrections}` } };
    if (reuseCandidate) return { attempt, attemptKind: kind, correctionOrdinal: existingForAttempt.request.value.correctionOrdinal, authorization, previous: null, reuseCandidate: true };
    if (attempt !== latestPhysicalAttempt + 1) return { stop: { code: "STOPPED_CORRECTION_POLICY", reason: "correction must use the next physical attempt" } };
    const correctionCount = existingAttempts.filter((entry) => entry.request.value.attemptKind === "correction").length;
    if (ordinal !== correctionCount + 1) return { stop: { code: "STOPPED_CORRECTION_POLICY", reason: `correction ordinal must be the next sequential correction ordinal after ${correctionCount}` } };
    const initial = existingAttempts.find((entry) => entry.attempt === 1 && entry.request.value.attemptKind === "initial");
    if (!initial) return { stop: { code: "STOPPED_CORRECTION_POLICY", reason: "a correction requires the recorded initial attempt" } };
    if (existingAttempts.some((entry) => entry.request.value.attemptKind === "correction" && entry.request.value.correctionOrdinal === ordinal) && !reuseCandidate) return { stop: { code: "STOPPED_ATTEMPT_CONTRADICTION", reason: `correction ordinal ${ordinal} is already recorded for this job` } };
    return { attempt, attemptKind: kind, correctionOrdinal: ordinal, authorization, previous: null, reuseCandidate };
  }
  if (!reuseCandidate && attempt !== latestPhysicalAttempt + 1) return { stop: { code: "STOPPED_TECHNICAL_REPLAY_CONTRADICTION", reason: "technical replay must use the next physical attempt" } };
  if (existingAttempts.some((entry) => entry.request.value.attemptKind === "technical_replay") && !reuseCandidate) return { stop: { code: "STOPPED_TECHNICAL_REPLAY_LIMIT", reason: "only one technical replay is allowed for a job" } };
  const previous = reuseCandidate ? existingAttempts.find((entry) => entry.attempt === attempt - 1) : existingAttempts.at(-1);
  if (!previous || previous.attempt !== attempt - 1 || previous.request.value.attemptKind === undefined) return { stop: { code: "STOPPED_TECHNICAL_REPLAY_CONTRADICTION", reason: "technical replay must immediately follow a recorded attempt" } };
  if (!current) return { stop: { code: "STOPPED_TECHNICAL_REPLAY_CONTRADICTION", reason: "technical replay requires the exact bound session" } };
  const failure = await qualifyingTransportFailure(root, previous);
  if (!failure.qualified) return { stop: { code: "STOPPED_TECHNICAL_REPLAY_CONTRADICTION", reason: "technical replay requires a qualifying transport failure" } };
  const observed = failure.capsule.value.observedSessionIds ?? [];
  if (!observed.includes(current.value.sessionId)) return { stop: { code: "STOPPED_TECHNICAL_REPLAY_CONTRADICTION", reason: "technical replay bound session does not match the failed attempt evidence" } };
  return { attempt, attemptKind: kind, correctionOrdinal: null, authorization, previous, previousCapsule: failure.capsule, reuseCandidate };
}

function applicableQuestions(questions, { phaseKey = null, workPackageKey = null } = {}) {
  return questions.filter((question) => questionApplies(question, { phaseKey, workPackageKey }));
}

async function replacementAuthorization(root, options) {
  const authorizationPath = assertRelativeInput(options.replacementAuthorizationPath ?? options.replacementAuthorizationFile, "replacement authorization path");
  const expectedDigest = requiredText(options.replacementAuthorizationDigest ?? options.replacementDigest, "replacement authorization digest", 128);
  if (!/^[a-f0-9]{64}$/i.test(expectedDigest)) fail("replacement authorization digest must be SHA-256", "E_BINDING_REPLACEMENT");
  const evidence = await fileReference(root, authorizationPath, "replacement authorization evidence");
  if (evidence.sha256 !== expectedDigest) fail("replacement authorization digest does not match the current file bytes", "E_BINDING_REPLACEMENT");
  return evidence;
}

async function candidateSessionId(root, options) {
  const direct = options.candidateSessionId ?? options.expectedSession ?? null;
  const file = options.candidateSessionFile ?? options.candidateSessionPath ?? null;
  const fromFile = file === null ? null : (await readOwnedFile(root, assertRelativeInput(file, "candidate session file"), "candidate session file")).toString("utf8").trim();
  if (direct !== null && fromFile !== null && direct !== fromFile) fail("candidate session ID and candidate session file contradict", "E_SESSION_CANDIDATE");
  const value = direct ?? fromFile;
  return value === null ? null : requiredText(value, "candidate session ID", 512);
}

export async function dispatchRole(options = {}) {
  const projectRoot = await realDirectory(options.root, "root");
  const recordsRoot = recordsRootValue(options.recordsRoot);
  const publicRole = roleName(options.role);
  const controllerRole = CONTROLLER_ROLES[publicRole];
  const jobKey = assertRelativeInput(requiredText(options.jobKey, "jobKey", 1024), "jobKey");
  if (jobKey === ".") fail("jobKey must not be the project root", "E_RUNTIME_KEY");
  const purpose = requiredText(options.purpose ?? "substantive", "purpose", 256);
  let dispatchKeys;
  try {
    dispatchKeys = dispatchContext(options);
  } catch (error) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_INVALID_DISPATCH_CONTEXT", error.message);
  }
  let config;
  try {
    config = await deriveActiveConfiguration({ root: projectRoot, recordsRoot });
  } catch (error) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_CONFIGURATION_CONTRADICTION", error.message);
  }
  if (config.status !== "CONFIRMED" || !config.active) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "AWAITING_CONFIGURATION_CONFIRMATION", "a confirmed non-conflicting configuration is required");
  const questions = await listQuestions({ root: projectRoot, recordsRoot });
  const applicable = applicableQuestions(questions, dispatchKeys);
  const open = applicable.filter((question) => question.state === "OPEN");
  const contradictory = applicable.filter((question) => question.state === "CONTRADICTORY");
  if (contradictory.length > 0) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_QUESTION_CONTRADICTION", "an applicable question record is contradictory", { questionKeys: contradictory.slice(0, 32).map((question) => question.questionKey), reasons: contradictory.slice(0, 32).map((question) => question.reason) });
  if (open.length > 0) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "AWAITING_HUMAN_ANSWER", "an applicable question remains open", { questionKeys: open.slice(0, 32).map((question) => question.questionKey) });
  const roleConfig = config.active.configuration.answers[configRoleKey(publicRole)];
  let roleProfile;
  try {
    roleProfile = activeRoleProfile(publicRole, roleConfig, options);
  } catch (error) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_CONFIGURATION_PROFILE_CONTRADICTION", error.message);
  }
  let sessionScope;
  try {
    sessionScope = deriveSessionScope(publicRole, roleConfig, dispatchKeys);
  } catch (error) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_SESSION_SCOPE", error.message);
  }
  const brief = await readBrief(projectRoot, options.briefPath ?? options.brief);
  const envelope = await loadEnvelope(projectRoot, options);
  if (!envelope.valid) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_INVALID_ENVELOPE", envelope.error);
  if (!Array.isArray(options.args) || options.args.some((item) => typeof item !== "string")) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_INVALID_ARGS", "dispatch args must be supplied as a string array");
  const adapter = requiredText(options.adapter, "adapter", 2048);
  const adapterIdentifier = requiredText(roleProfile.adapterIdentifier, "adapterIdentifier", 512);
  const provider = options.provider ?? adapterIdentifier;
  const providerFamily = roleProfile.providerFamily;
  let invocationDigest = null;
  try {
    if (envelope.adapterEnvelope?.invocationContract !== undefined && envelope.adapterEnvelope?.invocationContract !== null) invocationDigest = invocationContractDigest(envelope.adapterEnvelope.invocationContract);
  } catch (error) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_INVOCATION_CONTRACT", error.message);
  }
  const context = contextEvidence(publicRole, providerFamily, adapterIdentifier, options.args, options.contextEvidence ?? null);
  if (isClaudePlanner2(publicRole, providerFamily) && context?.preflightStatus !== "verified") return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_AUTO_COMPACTION_UNVERIFIED", "Claude Planner 2 requires exactly one mechanically inspected --autocompact 400k declaration in the actual dispatch argv", { contextManagement: context });
  let bindingProjection;
  let current;
  let activePending = null;
  let activePendingDispatch = null;
  try {
    bindingProjection = await bindingState(projectRoot, recordsRoot, publicRole, sessionScope);
    current = bindingProjection.current;
    activePending = bindingProjection.active;
    if (activePending) activePendingDispatch = await pendingDispatchRequest(projectRoot, activePending);
  } catch (error) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_BINDING_CHAIN", error.message);
  }
  let expectedSession = null;
  let replacement = null;
  try {
    if (options.replaceSession === true) {
      if (!current) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_REPLACEMENT_AUTHORIZATION", "session replacement requires an existing binding for the exact role/scope");
      if (!['create', 'bind_existing'].includes(options.replacementMode)) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_REPLACEMENT_AUTHORIZATION", "replacementMode must be explicitly create or bind_existing");
      if (options.currentBindingPath !== current.path) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_REPLACEMENT_AUTHORIZATION", "current binding path is required and must match the immutable role/scope binding");
      if (options.currentBindingDigest !== current.digest) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_REPLACEMENT_AUTHORIZATION", "current binding digest is required and must match the immutable role/scope binding");
      const authorization = await replacementAuthorization(projectRoot, options);
      const candidate = options.replacementMode === "bind_existing" ? await candidateSessionId(projectRoot, options) : null;
      if (options.replacementMode === "create" && options.createSession !== true) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_REPLACEMENT_AUTHORIZATION", "replacement create mode requires createSession=true");
      if (options.replacementMode === "create" && (options.expectedSession !== undefined || options.candidateSessionId !== undefined || options.candidateSessionFile !== undefined)) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_REPLACEMENT_AUTHORIZATION", "replacement create mode cannot carry an expected or candidate session");
      if (options.replacementMode === "bind_existing" && !candidate) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_EXISTING_SESSION_REQUIRED", "replacement bind_existing mode requires a candidate session ID or file");
      expectedSession = candidate;
      replacement = {
        mode: options.replacementMode,
        currentBindingPath: current.path,
        currentBindingDigest: current.digest,
        authorization,
      };
    } else if (current) {
      expectedSession = current.value.sessionId;
      if (options.expectedSession !== undefined && options.expectedSession !== expectedSession) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_SESSION_MISMATCH", "requested session does not match the immutable binding", { expectedSession, requested: options.expectedSession, scope: sessionScope });
      if (options.candidateSessionId !== undefined || options.candidateSessionFile !== undefined) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_SESSION_MISMATCH", "a bound role cannot supply a different candidate session");
      if (options.createSession === true || options.allowUnboundSession === true) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_SESSION_ALREADY_BOUND", "a bound role must resume its exact session; unbound creation is not allowed");
    } else {
      const mode = publicRole === "planner-2" ? roleConfig.sessionMode : "create";
      if (mode === "bind_existing") {
        expectedSession = await candidateSessionId(projectRoot, options);
        if (!expectedSession) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_EXISTING_SESSION_REQUIRED", "bind_existing mode requires a candidate session ID or file");
        if (options.createSession === true || options.allowUnboundSession === true) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_EXISTING_SESSION_REQUIRED", "bind_existing verification cannot use unbound creation");
      } else if (mode === "create") {
        if (options.expectedSession !== undefined || options.candidateSessionId !== undefined || options.candidateSessionFile !== undefined) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_SESSION_MISMATCH", "create mode cannot carry an expected session");
        if (options.createSession !== true && options.allowUnboundSession !== true) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_UNBOUND_SESSION", "an explicit validated unbound-session creation request is required before the first provider call", { mode });
      } else {
        return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_SESSION_SCOPE", "unsupported session mode");
      }
    }
  } catch (error) {
    const stopCode = error.code === "E_SESSION_CANDIDATE" && options.replaceSession !== true ? "STOPPED_EXISTING_SESSION_REQUIRED" : options.replaceSession === true || error.code === "E_BINDING_REPLACEMENT" ? "STOPPED_REPLACEMENT_AUTHORIZATION" : "STOPPED_SESSION_PRECHECK";
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, stopCode, error.message);
  }
  const confirmedWaitCapability = config.active.configuration.answers.hostWaitCapability;
  const confirmedWaitPath = capabilityToWaitPath(confirmedWaitCapability);
  if (confirmedWaitCapability === "unavailable") return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_WAIT_PATH", "the confirmed host wait capability is unavailable; dispatch is not permitted");
  const waitPath = options.waitPath ?? confirmedWaitPath;
  if (!["single_outer_call", "described_equivalent", "unavailable"].includes(waitPath)) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_WAIT_PATH", "waitPath is not a recognized host capability");
  if (options.waitPath !== undefined && waitPath !== confirmedWaitPath) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_WAIT_PATH", "dispatch waitPath contradicts the confirmed host wait capability");
  if (waitPath === "unavailable" && options.suspensionAvailable === true) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: options.attempt ?? 1 }, "STOPPED_WAIT_PATH", "the configured host wait capability is unavailable and cannot be overridden by dispatch input");
  const suspensionAvailable = options.suspensionAvailable ?? waitPath !== "unavailable";
  const timeoutMs = options.timeoutMs ?? parseNumericTimeout(config.active.configuration.answers.defaultTimeout);
  let existingAttempts;
  try {
    existingAttempts = await attemptDirectories(projectRoot, recordsRoot, jobKey);
  } catch (error) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: Number.isInteger(options.attempt) ? options.attempt : 1 }, "STOPPED_ATTEMPT_POLICY", error.message);
  }
  if (activePending) {
    const pendingRequest = activePendingDispatch.value;
    if (options.attempt !== undefined && options.attempt !== pendingRequest.attempt) return dispatchStop({ root: projectRoot, recordsRoot, jobKey: pendingRequest.jobKey, attempt: pendingRequest.attempt }, "STOPPED_BINDING_PENDING_CONTRADICTION", "the requested attempt contradicts the unresolved pending dispatch");
    if (options.attemptKind !== undefined && options.attemptKind !== pendingRequest.attemptKind) return dispatchStop({ root: projectRoot, recordsRoot, jobKey: pendingRequest.jobKey, attempt: pendingRequest.attempt }, "STOPPED_BINDING_PENDING_CONTRADICTION", "the requested attempt kind contradicts the unresolved pending dispatch");
    if (options.correctionOrdinal !== undefined && options.correctionOrdinal !== pendingRequest.correctionOrdinal) return dispatchStop({ root: projectRoot, recordsRoot, jobKey: pendingRequest.jobKey, attempt: pendingRequest.attempt }, "STOPPED_BINDING_PENDING_CONTRADICTION", "the requested correction ordinal contradicts the unresolved pending dispatch");
  }
  const attemptOptions = activePending ? {
    ...options,
    attempt: options.attempt ?? activePendingDispatch.value.attempt,
    attemptKind: options.attemptKind ?? activePendingDispatch.value.attemptKind,
    correctionOrdinal: options.correctionOrdinal ?? activePendingDispatch.value.correctionOrdinal,
  } : options;
  const attemptPolicy = await validateAttemptPolicy({ root: projectRoot, config, existingAttempts, current, options: attemptOptions, jobKey });
  if (attemptPolicy.stop) {
    const stopAttempt = Number.isInteger(options.attempt) ? options.attempt : existingAttempts.at(-1)?.attempt ?? 1;
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt: stopAttempt }, attemptPolicy.stop.code, attemptPolicy.stop.reason);
  }
  const { attempt, attemptKind: selectedAttemptKind, correctionOrdinal, authorization: attemptAuthorization, previous } = attemptPolicy;
  const identityForAttempt = (candidateAttempt) => {
    const candidateRoot = runtimePath(recordsRoot, `jobs/${jobKey}/attempt-${padAttempt(candidateAttempt)}`);
    return dispatchRequestIdentity({
      publicRole,
      controllerRole,
      jobKey,
      attempt: candidateAttempt,
      attemptKind: selectedAttemptKind,
      correctionOrdinal,
      attemptAuthorization,
      purpose,
      phaseKey: dispatchKeys.phaseKey,
      workPackageKey: dispatchKeys.workPackageKey,
      sessionScope,
      brief,
      configuration: config.active,
      binding: current,
      roleProfile,
      adapterIdentifier,
      adapter,
      providerFamily,
      args: options.args,
      invocationContractDigest: invocationDigest,
      resultPath: `${candidateRoot}/result.json`,
      artifactDir: `${candidateRoot}/controller`,
      envelope: envelope.adapterEnvelope,
      sourceFile: envelope.sourceFile,
      sourceFileDigest: envelope.sourceFileDigest,
      expectedSession,
      waitPath,
      timeoutMs,
      context,
      replacement,
    });
  };
  if (previous && !replayIdentityMatches(previous.request.value, identityForAttempt(attempt))) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_TECHNICAL_REPLAY_CONTRADICTION", "technical replay changed the immutable job, brief, scope, role, adapter profile, or invocation contract identity");
  }
  const attemptRoot = runtimePath(recordsRoot, `jobs/${jobKey}/attempt-${padAttempt(attempt)}`);
  const artifactDir = `${attemptRoot}/controller`;
  const resultPath = `${attemptRoot}/result.json`;
  const identity = identityForAttempt(attempt);
  const requestPath = `${attemptRoot}/dispatch-request.v1.json`;
  if (activePending) {
    if (!sameRequest(activePendingDispatch.value, identity)) {
      return dispatchStop({ root: projectRoot, recordsRoot, jobKey: activePendingDispatch.value.jobKey, attempt: activePendingDispatch.value.attempt }, "STOPPED_BINDING_PENDING_CONTRADICTION", "the requested dispatch identity contradicts the unresolved pending request", { pendingRequestPath: activePendingDispatch.path, pendingRequestDigest: activePendingDispatch.digest, requestedDigest: canonicalDigest(identity) });
    }
    return {
      status: "REUSED",
      reused: true,
      dispatchCount: 0,
      runtimeStatus: "AWAITING_SESSION_BINDING",
      nextActor: "Planning Lead",
      bindingRequestPath: activePending.path,
      bindingRequestDigest: activePending.digest,
      dispatchRequestPath: activePendingDispatch.path,
      dispatchRequestDigest: activePendingDispatch.digest,
      dispatchIdentityHash: activePending.value.dispatchIdentityHash ?? null,
      resultPath: activePending.value.sourceResultPath,
      resultDigest: activePending.value.sourceResultDigest,
      capsulePath: activePending.value.capsulePath ?? null,
      observedSessionIds: [activePending.value.sessionId],
      attempt: activePendingDispatch.value.attempt,
      jobKey: activePendingDispatch.value.jobKey,
    };
  }
  const existingRequest = await readJsonIfPresent(projectRoot, requestPath, "dispatch request");
  if (existingRequest && !sameRequest(existingRequest.value, identity)) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_DISPATCH_CONTRADICTION", "same job key and attempt have a different dispatch identity", { existingRequest: existingRequest.path, requestedDigest: canonicalDigest(identity) });
  if (!existingRequest && existingAttempts.length > 0 && !current && existingAttempts.some((entry) => !sameRequest(entry.request.value, identity))) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_DISPATCH_CONTRADICTION", "an unbound dispatch identity cannot be reused or silently replaced");
  }
  const request = existingRequest ? { ...existingRequest, reused: true } : await writeImmutableRecord(projectRoot, requestPath, identity);
  if (request.status === "STOPPED_VERBATIM_TOO_LARGE") return request;
  await recordEvent({ root: projectRoot, recordsRoot, eventType: "dispatch_requested", references: [{ path: request.path, sha256: request.digest }], data: { role: publicRole, jobKey, attempt } });
  const controllerResult = await dispatchProcessJob({
    root: projectRoot,
    adapterEnvelope: envelope.adapterEnvelope,
    adapterEnvelopeSourceFile: envelope.sourceFile,
    adapterEnvelopeSourceDigest: envelope.sourceFileDigest,
    adapter,
    adapterIdentifier,
    providerFamily,
    publicRole,
    roleProfile,
    invocationContractDigest: invocationDigest,
    args: options.args,
    result: resultPath,
    artifactDir,
    role: controllerRole,
    roleStatus: options.roleStatus,
    expectedSession,
    suspensionAvailable,
    hostTelemetry: options.hostTelemetry,
    timeoutMs,
    maxCapsuleBytes: options.maxCapsuleBytes,
    contextManagement: context,
  });
  await recordEvent({ root: projectRoot, recordsRoot, eventType: "provider_terminal", references: controllerResult.capsulePath ? [{ path: controllerResult.capsulePath, sha256: sha256Bytes(await readOwnedFile(projectRoot, controllerResult.capsulePath, "capsule")) }] : [], data: { role: publicRole, status: controllerResult.status, dispatchCount: controllerResult.dispatchCount } });
  if (controllerResult.capsulePath) {
    await recordEvent({ root: projectRoot, recordsRoot, eventType: "capsule_emitted", references: [{ path: controllerResult.capsulePath, sha256: sha256Bytes(await readOwnedFile(projectRoot, controllerResult.capsulePath, "capsule")) }], data: { role: publicRole, status: controllerResult.status } });
  }
  if (!["PASS", "FAIL", "REUSED"].includes(controllerResult.status)) {
    const controllerStopCode = controllerResult.status === "STOPPED_INVALID_ENVELOPE" ? "STOPPED_INVALID_ENVELOPE" : `STOPPED_CONTROLLER_${controllerResult.status}`;
    const stop = await dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, controllerStopCode, controllerResult.reason ?? "controller stopped before a terminal provider result", { controllerStatus: controllerResult.status, controllerCode: controllerResult.code ?? null });
    return { ...controllerResult, ...stop, runtimeStatus: "STOPPED", nextActor: "Planning Lead", stopCode: stop.stopCode };
  }
  if (!controllerResult.capsulePath || !(await readJsonIfPresent(projectRoot, resultPath, "provider result"))) {
    return { ...controllerResult, runtimeStatus: "STOPPED", nextActor: "Planning Lead", stopCode: "STOPPED_MISSING_RESULT" };
  }
  const rawResult = await rawResultForDispatch(projectRoot, resultPath);
  const observedSessionIds = [...new Set(extractSessionRefs(rawResult.value).map((item) => item.value).filter((value) => value.length > 0))];
  const validation = validateResultArtifact(rawResult.value);
  if (!validation.valid) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_INVALID_SESSION_EVIDENCE", "provider evidence is not a terminal result and cannot establish a session binding", { resultPath, resultDigest: rawResult.digest, resultValidation: validation });
  }
  if (observedSessionIds.length !== 1) {
    return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_AMBIGUOUS_SESSION", "provider evidence must contain exactly one usable observed session identifier", { observedSessionIds, resultPath, resultDigest: rawResult.digest, resultValidation: validation });
  }
  if (expectedSession !== null && observedSessionIds[0] !== expectedSession) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_SESSION_MISMATCH", "provider evidence did not match the requested session", { expectedSession, observedSessionIds, sessionScope });
  if (!current || replacement) {
    const pendingVersion = replacement ? (current.version + 1) : null;
    const pending = {
      schemaVersion: SESSION_BINDING_REQUEST_SCHEMA,
      lifecycle: "PENDING",
      publicRole,
      controllerRole,
      scope: sessionScope,
      sessionId: observedSessionIds[0],
      provider: String(provider),
      sourceResultPath: resultPath,
      sourceResultDigest: rawResult.digest,
      dispatchIdentityHash: controllerResult.dispatchIdentityHash ?? null,
      dispatchRequestPath: request.path,
      dispatchRequestDigest: request.digest,
      attemptKind: selectedAttemptKind,
      correctionOrdinal,
      attemptAuthorization: attemptAuthorization ?? null,
      capsulePath: controllerResult.capsulePath ?? null,
      resultValidation: validation,
      expectedSession,
      sessionMode: replacement?.mode ?? (publicRole === "planner-2" ? roleConfig.sessionMode : "create"),
      replacement: Boolean(replacement),
      ...(replacement ? {
        replacementVersion: pendingVersion,
        currentBindingPath: replacement.currentBindingPath,
        currentBindingDigest: replacement.currentBindingDigest,
        replacementAuthorization: replacement.authorization,
      } : {}),
    };
    let pendingWrite;
    try {
      pendingWrite = await writeImmutableRecord(projectRoot, pendingBindingPath(publicRole, sessionScope, recordsRoot, { replacementVersion: pendingVersion }), pending);
    } catch (error) {
      return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_BINDING_PENDING_CONTRADICTION", error.message, { replacementVersion: pendingVersion, replacement: Boolean(replacement) });
    }
    await recordEvent({ root: projectRoot, recordsRoot, eventType: "session_binding_requested", references: [{ path: pendingWrite.path, sha256: pendingWrite.digest }, { path: resultPath, sha256: rawResult.digest }, ...(replacement ? [{ path: replacement.authorization.path, sha256: replacement.authorization.sha256 }] : [])], data: { publicRole, scope: sessionScope, sessionId: observedSessionIds[0], replacement: Boolean(replacement) } });
    return { ...controllerResult, runtimeStatus: "AWAITING_SESSION_BINDING", nextActor: "Planning Lead", bindingRequestPath: pendingWrite.path, bindingRequestDigest: pendingWrite.digest, observedSessionIds, resultDigest: rawResult.digest };
  }
  if (observedSessionIds[0] !== current.value.sessionId) return dispatchStop({ root: projectRoot, recordsRoot, jobKey, attempt }, "STOPPED_SESSION_MISMATCH", "provider evidence did not contain the immutable bound session", { expectedSession: current.value.sessionId, observedSessionIds });
  return { ...controllerResult, runtimeStatus: "RESULT_READY_FOR_PLANNING_LEAD", nextActor: "Planning Lead", bindingPath: current.path, bindingDigest: current.digest, observedSessionIds, resultDigest: rawResult.digest };
}

export class RuntimeCoordinator {
  constructor(options = {}) {
    this.root = options.root;
    this.recordsRoot = options.recordsRoot ?? DEFAULT_RECORDS_ROOT;
  }

  questionnaire(options = {}) { return createQuestionnaire({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
  async createConfiguration(options = {}) {
    const result = await createConfigurationDraft({ ...options, root: this.root, recordsRoot: this.recordsRoot });
    if (result.path && result.digest) await recordEvent({ root: result.projectRoot, recordsRoot: result.recordsRoot, eventType: "config_versioned", references: [{ path: result.path, sha256: result.digest }], data: { version: result.record.version, lifecycle: result.record.lifecycle } });
    return result;
  }
  createConfig(options = {}) { return this.createConfiguration(options); }
  async confirmConfiguration(options = {}) {
    const result = await confirmConfiguration({ ...options, root: this.root, recordsRoot: this.recordsRoot });
    if (result.path && result.digest) await recordEvent({ root: result.projectRoot, recordsRoot: result.configuration.answers.recordsRoot, eventType: "config_versioned", references: [{ path: result.path, sha256: result.digest }, { path: result.confirmation.configurationPath, sha256: result.confirmation.configurationDigest }], data: { version: result.confirmation.version, lifecycle: result.confirmation.lifecycle } });
    return result;
  }
  confirmConfig(options = {}) { return this.confirmConfiguration(options); }
  status(options = {}) { return runtimeStatus({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
  nextStop(options = {}) { return this.status(options); }
  acknowledgeResult(options = {}) { return acknowledgeResult({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
  async openQuestion(options = {}) {
    const result = await openQuestion({ ...options, root: this.root, recordsRoot: this.recordsRoot });
    if (result.path && result.digest) await recordEvent({ root: result.projectRoot, recordsRoot: this.recordsRoot, eventType: "question_opened", references: [{ path: result.path, sha256: result.digest }], data: { questionKey: result.record.questionKey } });
    return result;
  }
  async answerQuestion(options = {}) {
    const result = await answerQuestion({ ...options, root: this.root, recordsRoot: this.recordsRoot });
    if (result.path && result.digest) await recordEvent({ root: result.projectRoot, recordsRoot: this.recordsRoot, eventType: "answer_recorded", references: [{ path: result.path, sha256: result.digest }, { path: result.questionPath, sha256: result.questionDigest }], data: { questionKey: result.record.questionKey } });
    return result;
  }
  async withdrawQuestion(options = {}) {
    const result = await withdrawQuestion({ ...options, root: this.root, recordsRoot: this.recordsRoot });
    if (result.path && result.digest) await recordEvent({ root: result.projectRoot, recordsRoot: this.recordsRoot, eventType: "question_withdrawn", references: [{ path: result.path, sha256: result.digest }, { path: result.questionPath, sha256: result.questionDigest }], data: { questionKey: result.record.questionKey } });
    return result;
  }
  listQuestions(options = {}) { return listQuestions({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
  inspectQuestion(options = {}) { return inspectQuestion({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
  confirmSessionBinding(options = {}) { return confirmSessionBinding({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
  inspectSessionBindings(options = {}) { return inspectSessionBindings({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
  dispatch(options = {}) { return dispatchRole({ ...options, root: this.root, recordsRoot: this.recordsRoot }); }
}

export const createRuntimeCoordinator = (options = {}) => new RuntimeCoordinator(options);
export const status = runtimeStatus;
export const dispatch = dispatchRole;
export const recordRuntimeEvent = recordEvent;
export const acknowledge = acknowledgeResult;
