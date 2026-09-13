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
import { deriveInvocationEvidenceMeaning, emitResultCapsule, loadAndValidateCapsule } from "./result-capsule.mjs";

export const JOB_CONTROLLER_SCHEMA = "dd.process-job.v1";
export const ADAPTER_ENVELOPE_SCHEMA = "dd.adapter-envelope.v1";
export const DISPATCH_IDENTITY_SCHEMA = "dd.dispatch-identity.v2";
export const INVOCATION_CONTRACT_SCHEMA = "dd.invocation-contract.v1";
const ADAPTER_ENVELOPE_LIMITATION = "declaration/contract evidence only; argv and adapter cwd behavior are not OS attestation";
const INVOCATION_LIMITATION = "invocation evidence is requested argv or bounded adapter-default evidence only; provider application, OS sandboxing, filesystem containment, and no-commit enforcement are unknown";
const INVOCATION_OUTCOMES = new Set(["verified_requested", "not_applicable", "unverified"]);
const INVOCATION_FORMS = new Set(["separate", "equals", "presence"]);
const INVOCATION_SETTINGS = new Set(["modelLabel", "effort", "permissionProfile", "noCommit", "autocompact"]);
const CLAUDE_EXECUTOR_DEFAULT_REASON = "adapter-parser/default_absence:acceptEdits";
const CLAUDE_EXECUTOR_DEFAULT_LIMITATION = "adapter-parser/default evidence only; provider application, OS sandboxing, filesystem containment, and no-commit enforcement are unknown";
const CLAUDE_EXECUTOR_DEFAULT_ABSENT_FLAGS = Object.freeze([
  "--read-only",
  "--dangerously-skip-permissions",
  "--permission-mode",
  "--sandbox",
  "--lane",
  "--permission-profile",
]);

const FIXTURE_CAPABILITIES = Object.freeze({
  providerFamily: "other",
  modelLabel: null,
  effort: null,
  permissionProfile: null,
  noCommit: null,
  autocompact: null,
});

const CONTRACT_FIXTURE_CAPABILITIES = Object.freeze({
  providerFamily: "other",
  modelLabel: Object.freeze({ flag: "--model", forms: Object.freeze(["separate"]) }),
  effort: Object.freeze({ flag: "--effort", forms: Object.freeze(["separate"]) }),
  permissionProfile: Object.freeze({ flag: "--permission-profile", forms: Object.freeze(["separate"]) }),
  noCommit: null,
  autocompact: Object.freeze({ flag: "--autocompact", forms: Object.freeze(["separate"]) }),
});

const CLAUDE_DELEGATE_CAPABILITIES = Object.freeze({
  providerFamily: "claude",
  modelLabel: Object.freeze({ flag: "--model", forms: Object.freeze(["separate"]), noTerminator: true }),
  effort: Object.freeze({ flag: "--effort", forms: Object.freeze(["separate"]), noTerminator: true }),
  permissionProfile: Object.freeze({
    values: Object.freeze({
      "read-only": Object.freeze({ flag: "--read-only", forms: Object.freeze(["presence"]), noTerminator: true }),
      "workspace-write": Object.freeze({
        adapterDefaultProfile: "acceptEdits",
        absentFlags: CLAUDE_EXECUTOR_DEFAULT_ABSENT_FLAGS,
        noTerminator: true,
      }),
    }),
  }),
  noCommit: null,
  autocompact: Object.freeze({ flag: "--autocompact", forms: Object.freeze(["separate"]), noTerminator: true }),
});

const CODEX_DELEGATE_CAPABILITIES = Object.freeze({
  providerFamily: "codex",
  modelLabel: Object.freeze({ flag: "--model", forms: Object.freeze(["separate"]), noTerminator: true }),
  effort: Object.freeze({ flag: "--effort", forms: Object.freeze(["separate"]), noTerminator: true }),
  permissionProfile: Object.freeze({
    values: Object.freeze({
      "read-only": Object.freeze({ flag: "--read-only", forms: Object.freeze(["presence"]), noTerminator: true }),
      "workspace-write": Object.freeze({ flag: "--sandbox", forms: Object.freeze(["separate"]), noTerminator: true }),
    }),
  }),
  noCommit: null,
  autocompact: null,
});

const ADAPTER_CAPABILITIES = Object.freeze({
  "local-fixture": FIXTURE_CAPABILITIES,
  "planner-fixture": FIXTURE_CAPABILITIES,
  "executor-fixture": FIXTURE_CAPABILITIES,
  fixture: FIXTURE_CAPABILITIES,
  "contract-fixture": CONTRACT_FIXTURE_CAPABILITIES,
  "claude-delegate": CLAUDE_DELEGATE_CAPABILITIES,
  "codex-delegate": CODEX_DELEGATE_CAPABILITIES,
});

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

function dispatchIdentity(options, { resultRelative, artifactRelative, jobRelative, capsuleRelative, adapterEnvelopeDigest, invocationContractDigest: contractDigest = null }) {
  const identity = {
    schemaVersion: DISPATCH_IDENTITY_SCHEMA,
    role: options.role,
    adapter: options.adapter,
    adapterIdentifier: options.adapterIdentifier ?? null,
    providerFamily: options.providerFamily ?? null,
    roleProfile: options.roleProfile ?? null,
    args: options.args,
    resultPath: resultRelative,
    expectedSession: options.expectedSession,
    artifactDir: artifactRelative,
    jobRecord: jobRelative,
    capsulePath: capsuleRelative,
    timeoutMs: options.timeoutMs,
    adapterEnvelopeDigest,
    invocationContractDigest: contractDigest ?? options.invocationContractDigest ?? null,
    contextManagement: options.contextManagement ?? null,
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
    adapterIdentifier: options.adapterIdentifier ?? null,
    providerFamily: options.providerFamily ?? null,
    roleProfile: options.roleProfile ?? null,
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
    invocationContract: options.adapterEnvelope?.invocationContract ?? null,
    invocationContractDigest: options.invocationContractDigest ?? null,
    contextManagement: options.contextManagement ?? null,
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

function allowedKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${label} contains an unsupported field: ${key}`, "E_INVOCATION_CONTRACT");
  }
}

function normalizeInvocationDeclaration(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, "E_INVOCATION_CONTRACT");
  const outcome = value.outcome;
  if (!INVOCATION_OUTCOMES.has(outcome)) fail(`${label}.outcome is unsupported`, "E_INVOCATION_CONTRACT");
  if (outcome === "not_applicable") {
    allowedKeys(value, ["outcome", "capability"], label);
    return { outcome, capability: boundedText(value.capability, `${label}.capability`, 128) };
  }
  if (outcome === "unverified") {
    allowedKeys(value, ["outcome", "reason"], label);
    return { outcome, reason: boundedText(value.reason ?? "unverified invocation setting", `${label}.reason`, 256) };
  }
  allowedKeys(value, ["outcome", "flag", "value", "form", "index"], label);
  const flag = boundedText(value.flag, `${label}.flag`, 128);
  if (!flag.startsWith("--")) fail(`${label}.flag must be a long option`, "E_INVOCATION_CONTRACT");
  const form = value.form;
  if (!INVOCATION_FORMS.has(form)) fail(`${label}.form is unsupported`, "E_INVOCATION_CONTRACT");
  const normalized = { outcome, flag, form };
  if (form === "presence") {
    if (value.value !== undefined) fail(`${label}.presence cannot declare a value`, "E_INVOCATION_CONTRACT");
  } else {
    normalized.value = boundedText(value.value, `${label}.value`, 512);
  }
  if (value.index !== undefined && value.index !== null) {
    if (!Number.isInteger(value.index) || value.index < 0 || value.index > 4095) fail(`${label}.index is out of bounds`, "E_INVOCATION_CONTRACT");
    normalized.index = value.index;
  } else {
    normalized.index = null;
  }
  return normalized;
}

export function normalizeInvocationContract(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail("adapter envelope requires a versioned invocationContract", "E_INVOCATION_CONTRACT");
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) fail("invocationContract must be an object", "E_INVOCATION_CONTRACT");
  allowedKeys(value, ["schemaVersion", "version", "settings"], "invocationContract");
  if (value.schemaVersion !== INVOCATION_CONTRACT_SCHEMA || value.version !== 1) fail(`invocationContract must use ${INVOCATION_CONTRACT_SCHEMA} version 1`, "E_INVOCATION_CONTRACT");
  if (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) fail("invocationContract.settings must be an object", "E_INVOCATION_CONTRACT");
  if (Object.keys(value.settings).length > INVOCATION_SETTINGS.size) fail("invocationContract.settings exceeds its bounded setting count", "E_INVOCATION_CONTRACT");
  for (const key of Object.keys(value.settings)) {
    if (!INVOCATION_SETTINGS.has(key)) fail(`invocationContract.settings contains an unsupported setting: ${key}`, "E_INVOCATION_CONTRACT");
  }
  const settings = {};
  for (const key of Object.keys(value.settings).sort()) settings[key] = normalizeInvocationDeclaration(value.settings[key], `invocationContract.settings.${key}`);
  return { schemaVersion: INVOCATION_CONTRACT_SCHEMA, version: 1, settings };
}

export function invocationContractDigest(value) {
  const normalized = normalizeInvocationContract(value, { required: true });
  return sha256Bytes(stableJson(normalized));
}

function capabilityForSetting(capabilities, key, expectedValue) {
  const declared = capabilities?.[key];
  if (declared === null) return { state: "not_transported", capability: null };
  if (!declared || !declared.values || typeof declared.values !== "object") {
    return { state: declared === undefined ? "unsupported" : "transported", capability: declared ?? null };
  }
  if (!Object.prototype.hasOwnProperty.call(declared.values, expectedValue)) {
    return { state: "unsupported", capability: null };
  }
  return { state: "transported", capability: declared.values[expectedValue] ?? null };
}

export function validateAdapterProviderFamily({ adapterIdentifier, providerFamily } = {}) {
  const capabilities = ADAPTER_CAPABILITIES[adapterIdentifier];
  if (!capabilities) fail(`adapter capability is not mapped for invocation contract validation: ${adapterIdentifier}`, "E_INVOCATION_UNVERIFIED");
  if (capabilities.providerFamily !== providerFamily) {
    fail(`adapter ${adapterIdentifier} requires providerFamily ${capabilities.providerFamily}, received ${providerFamily}`, "E_INVOCATION_UNVERIFIED");
  }
  return capabilities;
}

function knownSettingFlags(key) {
  return {
    modelLabel: ["--model"],
    effort: ["--effort"],
    permissionProfile: ["--permission-profile", "--read-only", "--sandbox", "--permission-mode", "--dangerously-skip-permissions", "--lane"],
    noCommit: ["--no-commit"],
    autocompact: ["--autocompact"],
  }[key] ?? [];
}

function argvOccurrences(args, flag, expectedForm = "separate") {
  const terminator = args.indexOf("--");
  const occurrences = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === flag) {
      occurrences.push({ index, form: expectedForm, value: expectedForm === "presence" ? null : (args[index + 1] === undefined || String(args[index + 1]).startsWith("--") ? null : args[index + 1]), postTerminator: terminator >= 0 && index > terminator });
    } else if (argument.startsWith(`${flag}=`)) {
      occurrences.push({ index, form: "equals", value: argument.slice(flag.length + 1), postTerminator: terminator >= 0 && index > terminator });
    }
  }
  return { terminator, occurrences };
}

function validateInvocationDeclaration(args, key, declaration, capabilityState, expectedValue, { publicRole, adapterIdentifier, providerFamily } = {}) {
  if (capabilityState?.state === "unsupported") {
    fail(`${key} configured value is unsupported by the adapter capability mapping`, "E_INVOCATION_UNVERIFIED");
  }
  const capability = capabilityState?.capability ?? null;
  if (declaration.outcome === "unverified") {
    const isClaudeExecutorDefault = key === "permissionProfile"
      && publicRole === "executor"
      && adapterIdentifier === "claude-delegate"
      && providerFamily === "claude"
      && expectedValue === "workspace-write"
      && capability?.adapterDefaultProfile === "acceptEdits";
    if (!isClaudeExecutorDefault || declaration.reason !== CLAUDE_EXECUTOR_DEFAULT_REASON) {
      fail(`${key} invocation setting is explicitly unverified without the mapped Claude Executor default evidence`, "E_INVOCATION_UNVERIFIED");
    }
    if (args.includes("--")) fail(`${key} adapter-default evidence cannot contain an option terminator`, "E_INVOCATION_CONTRACT");
    for (const flag of capability.absentFlags) {
      if (argvOccurrences(args, flag).occurrences.length > 0) fail(`${key} adapter-default evidence contains a permission/autonomy selector: ${flag}`, "E_INVOCATION_CONTRACT");
    }
    return {
      outcome: "unverified",
      setting: key,
      reason: declaration.reason,
      evidence: "adapter_default",
      form: "default_absence",
      profile: capability.adapterDefaultProfile,
      absentFlags: [...capability.absentFlags],
      limitation: CLAUDE_EXECUTOR_DEFAULT_LIMITATION,
    };
  }
  if (declaration.outcome === "not_applicable") {
    if (capabilityState?.state !== "not_transported" || declaration.capability !== "not_transported") fail(`${key} cannot be declared not_applicable for this adapter capability`, "E_INVOCATION_CONTRACT");
    for (const flag of knownSettingFlags(key)) {
      if (argvOccurrences(args, flag).occurrences.length > 0) fail(`${key} is declared not_applicable but its argv flag is present`, "E_INVOCATION_CONTRACT");
    }
    return { outcome: "not_applicable", setting: key };
  }
  if (!capability) fail(`${key} has no known transport capability for this adapter`, "E_INVOCATION_UNVERIFIED");
  if (capability.adapterDefaultProfile) fail(`${key} must use the mapped adapter-default declaration for this adapter/profile`, "E_INVOCATION_CONTRACT");
  if (!capability.forms.includes(declaration.form) || capability.flag !== declaration.flag) fail(`${key} invocation form or flag is not supported by this adapter capability`, "E_INVOCATION_CONTRACT");
  if (declaration.form !== "presence" && declaration.value !== expectedValue) fail(`${key} invocation value does not match the confirmed role profile`, "E_INVOCATION_CONTRACT");
  const { terminator, occurrences } = argvOccurrences(args, declaration.flag, declaration.form);
  if (occurrences.length !== 1) fail(`${key} invocation declaration is missing, duplicated, or contradictory in argv`, "E_INVOCATION_CONTRACT");
  const occurrence = occurrences[0];
  if (capability.noTerminator && terminator >= 0) fail(`${key} invocation argv contains an unsupported option terminator`, "E_INVOCATION_CONTRACT");
  if (occurrence.postTerminator) fail(`${key} invocation declaration appears after the argv terminator`, "E_INVOCATION_CONTRACT");
  if (occurrence.form !== declaration.form || occurrence.value !== (declaration.form === "presence" ? null : declaration.value)) fail(`${key} invocation declaration does not match the actual argv`, "E_INVOCATION_CONTRACT");
  if (declaration.index !== null && declaration.index !== occurrence.index) fail(`${key} invocation declaration index does not match the actual argv`, "E_INVOCATION_CONTRACT");
  if (key === "permissionProfile") {
    for (const flag of knownSettingFlags(key)) {
      if (flag === declaration.flag) continue;
      if (argvOccurrences(args, flag).occurrences.length > 0) fail(`permissionProfile argv contains an unsupported or contradictory selector: ${flag}`, "E_INVOCATION_CONTRACT");
    }
  }
  return { outcome: "verified_requested", setting: key, flag: declaration.flag, form: declaration.form, index: occurrence.index };
}

function validateExactSessionContinuation(args, adapterIdentifier, expectedSession) {
  if (expectedSession === null || expectedSession === undefined) return;
  if (adapterIdentifier !== "claude-delegate" && adapterIdentifier !== "codex-delegate") return;
  const { terminator, occurrences } = argvOccurrences(args, "--session", "separate");
  if (terminator >= 0 || occurrences.length !== 1 || occurrences[0].form !== "separate" || occurrences[0].value !== expectedSession) {
    fail(`${adapterIdentifier} exact-session continuation requires exactly one separated --session <id> matching the confirmed session`, "E_INVOCATION_CONTRACT");
  }
}

export function validateInvocationContract({ contract, args, adapterIdentifier, publicRole, roleProfile } = {}) {
  const normalized = normalizeInvocationContract(contract, { required: true });
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) fail("invocation contract validation requires a string argv", "E_INVOCATION_CONTRACT");
  const capabilities = validateAdapterProviderFamily({ adapterIdentifier, providerFamily: roleProfile?.providerFamily });
  const expectedKeys = ["modelLabel", "effort", "permissionProfile"];
  if (publicRole === "executor") expectedKeys.push("noCommit");
  if (publicRole === "planner-2" && roleProfile?.providerFamily === "claude") expectedKeys.push("autocompact");
  const actualKeys = Object.keys(normalized.settings);
  if (actualKeys.some((key) => !expectedKeys.includes(key)) || expectedKeys.some((key) => !actualKeys.includes(key))) fail("invocationContract settings do not exactly match the confirmed role requirements", "E_INVOCATION_CONTRACT");
  const verified = {};
  for (const key of expectedKeys) {
    const expectedValue = key === "autocompact" ? "400k" : roleProfile?.[key];
    const capability = capabilityForSetting(capabilities, key, expectedValue);
    verified[key] = validateInvocationDeclaration(args, key, normalized.settings[key], capability, expectedValue, {
      publicRole,
      adapterIdentifier,
      providerFamily: roleProfile?.providerFamily,
    });
  }
  return {
    contract: normalized,
    digest: sha256Bytes(stableJson(normalized)),
    verified,
    limitation: INVOCATION_LIMITATION,
  };
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
  const invocationContract = normalizeInvocationContract(value.invocationContract);
  const invocationContractDigest = invocationContract === null ? null : sha256Bytes(stableJson(invocationContract));
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
      invocationContract,
      invocationContractDigest,
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
      invocationContract,
      invocationContractDigest,
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
    const invocation = options.roleProfile
      ? validateInvocationContract({ contract: envelope.invocationContract, args: options.args, adapterIdentifier: options.adapterIdentifier, publicRole: options.publicRole ?? options.role, roleProfile: options.roleProfile })
      : null;
    if (options.roleProfile) validateExactSessionContinuation(options.args, options.adapterIdentifier, options.expectedSession ?? null);
    await assertNoReparseCrossing(root, envelope.effectiveWorkingDirectory, { allowMissing: false, includeFinal: true });
    const cwd = absoluteFromRelative(root, envelope.effectiveWorkingDirectory);
    const cwdStat = await fsp.lstat(cwd);
    if (!cwdStat.isDirectory()) fail("adapter envelope effectiveWorkingDirectory is not a directory", "E_ADAPTER_ENVELOPE");
    const normalizedDigest = sha256Bytes(stableJson(envelope));
    return {
      valid: true,
      envelope,
      normalizedDigest,
      invocation,
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
    adapterIdentifier: options.adapterIdentifier ?? null,
    providerFamily: options.providerFamily ?? null,
    roleProfile: options.roleProfile ?? null,
    publicRole: options.publicRole ?? null,
    invocationContractDigest: options.invocationContractDigest ?? null,
    contextManagement: options.contextManagement ?? null,
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
        invocationContractDigest: existingEnvelope.invocation?.digest ?? existingEnvelope.envelope.invocationContractDigest ?? null,
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
        contextManagement: options.contextManagement ?? null,
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
      invocationContractDigest: envelope.invocation?.digest ?? envelope.envelope.invocationContractDigest ?? null,
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
      contextManagement: options.contextManagement ?? null,
      adapterIdentifier: options.adapterIdentifier ?? null,
      providerFamily: options.providerFamily ?? null,
      roleProfile: options.roleProfile ?? null,
      adapterEnvelope: envelope.record,
      adapterEnvelopeDigest: envelope.normalizedDigest,
      invocationContract: envelope.envelope.invocationContract ?? null,
      invocationContractDigest: envelope.invocation?.digest ?? envelope.envelope.invocationContractDigest ?? null,
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
      contextManagement: options.contextManagement ?? null,
      adapterIdentifier: options.adapterIdentifier ?? null,
      providerFamily: options.providerFamily ?? null,
      roleProfile: options.roleProfile ?? null,
      rawArtifacts,
      changedPaths: options.changedPaths,
      gateCoverage: options.gateCoverage ?? {},
      adapterEnvelope: envelope.record,
      adapterEnvelopeDigest: envelope.normalizedDigest,
      invocationContract: envelope.envelope.invocationContract ?? null,
      invocationContractDigest: envelope.invocation?.digest ?? envelope.envelope.invocationContractDigest ?? null,
      invocationEvidence: envelope.invocation ? {
        meaning: deriveInvocationEvidenceMeaning(envelope.invocation.verified),
        providerApplication: "unknown",
        providerEnforcement: "unknown",
        contractDigest: envelope.invocation.digest,
        verified: envelope.invocation.verified,
        limitation: INVOCATION_LIMITATION,
      } : null,
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
