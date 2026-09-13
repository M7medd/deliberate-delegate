import fs from "node:fs/promises";
import path from "node:path";
import {
  absoluteFromRelative,
  assertNoReparseCrossing,
  assertRelativeInput,
  fail,
  realDirectory,
  readOwnedFile,
  sha256Bytes,
  stableJson,
  writeNewFile,
} from "./lifecycle-core.mjs";

export const PROJECT_CONFIG_SCHEMA = "dd.project-config.v1";
export const CONFIG_CONFIRMATION_SCHEMA = "dd.project-config-confirmation.v1";
export const QUESTIONNAIRE_SCHEMA = "dd.project-questionnaire.v1";
export const DEFAULT_RECORDS_ROOT = "docs/deliberate-delegate";
export const CONFIGURATION_DIRECTORY = "configuration";
export const MAX_RECORD_BYTES = 1024 * 1024;

export const QUESTIONNAIRE_FIELDS = Object.freeze({
  planningLead: Object.freeze(["modelLabel", "effort", "hostSurface"]),
  planner2: Object.freeze(["adapterIdentifier", "modelLabel", "effort", "permissionProfile", "providerFamily", "continuityPolicy", "sessionMode"]),
  executor: Object.freeze(["adapterIdentifier", "modelLabel", "effort", "permissionProfile", "providerFamily", "noCommit", "sessionScope"]),
  scalar: Object.freeze(["defaultTimeout", "correctionPolicy.maxCorrections", "hostWaitCapability"]),
  conditional: Object.freeze(["recordsRootOverride"]),
});

export const PROVIDER_FAMILIES = Object.freeze(["claude", "codex", "gemini", "other"]);
export const PLANNER_CONTINUITY_POLICIES = Object.freeze(["phase_scoped", "project_scoped"]);
export const EXECUTOR_SESSION_SCOPES = Object.freeze(["work_package_scoped"]);
export const NO_COMMIT_CLASSES = Object.freeze(["adapter_policy_declared", "host_tool_guarded", "instruction_only"]);

const AUTHORITY_KEYS = new Set([
  "phaseauthorization",
  "phaseauthorizationrecord",
  "scope",
  "allowlist",
  "authorizedscope",
  "completionboundary",
  "acceptancecriteria",
  "acceptance",
  "risktier",
  "riskdecision",
  "riskdowngrade",
  "safetycapsule",
  "validators",
  "validatorauthority",
  "correctiondecision",
  "correctionapproval",
  "rolereplacementapproval",
  "replacementapproval",
  "mergeapproval",
  "commitapproval",
  "releaseapproval",
  "pushapproval",
  "livesystemapproval",
  "liveactionapproval",
  "phaseadvance",
  "phaseadvancement",
  "phasestate",
  "stepstate",
  "phase",
  "step",
  "workpackage",
]);

function keyName(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function containsAuthorityKey(value, pathParts = []) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsAuthorityKey(value[index], [...pathParts, String(index)]);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (AUTHORITY_KEYS.has(keyName(key))) return [...pathParts, key].join(".");
    const found = containsAuthorityKey(child, [...pathParts, key]);
    if (found) return found;
  }
  return null;
}

function requiredText(value, label, { nullable = false, max = 512 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(`${label} must be a non-empty string${nullable ? " or null" : ""}`, "E_CONFIG_FIELD");
  }
  return value;
}

function optionalText(value, label, { nullable = true, max = 512 } = {}) {
  if (value === undefined) return undefined;
  return requiredText(value, label, { nullable, max });
}

function alias(value, keys, label) {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(value || {}, key));
  if (present.length === 0) return undefined;
  const selected = value[present[0]];
  for (const key of present.slice(1)) {
    if (stableJson(value[key]) !== stableJson(selected)) fail(`${label} has contradictory aliases`, "E_CONFIG_FIELD");
  }
  return selected;
}

function requireOne(value, label, choices) {
  if (!choices.includes(value)) fail(`${label} must be one of: ${choices.join(", ")}`, "E_CONFIG_FIELD");
  return value;
}

function normalizeTimeout(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.length > 0 && value.length <= 128) return value;
  fail("defaultTimeout must be a non-negative integer or a bounded duration label", "E_CONFIG_FIELD");
}

function normalizeRoleAnswers(value, role, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${role} configuration must be an object`, "E_CONFIG_FIELD");
  const normalized = {};
  for (const field of fields) {
    const valueForField = alias(value, [field], `${role}.${field}`);
    if (valueForField === undefined) fail(`${role}.${field} is required`, "E_CONFIG_FIELD");
    const textValue = requiredText(valueForField, `${role}.${field}`, { max: 512 });
    if (field === "permissionProfile" && /(?:danger|bypass|skip[-_ ]?permissions?|full[-_ ]?access)/i.test(textValue)) {
      fail(`${role}.permissionProfile selects a broader or dangerous mode that is not allowed for file-only execution`, "E_CONFIG_FIELD");
    }
    normalized[field] = textValue;
  }
  return normalized;
}

function normalizeAnswers(input, { recordsRoot = DEFAULT_RECORDS_ROOT } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("configuration answers must be a JSON object", "E_CONFIG_FIELD");
  const source = input.answers && typeof input.answers === "object" && !Array.isArray(input.answers) ? input.answers : input;
  const forbidden = containsAuthorityKey(source);
  if (forbidden) fail(`configuration cannot contain authority field: ${forbidden}`, "E_CONFIG_AUTHORITY");
  const lead = source.planningLead ?? source.lead;
  const planner2 = source.planner2 ?? source["planner-2"];
  const executor = source.executor;
  const planningLead = normalizeRoleAnswers(lead, "planningLead", QUESTIONNAIRE_FIELDS.planningLead);
  planningLead.adapterIdentifier = null;
  const planner = normalizeRoleAnswers(planner2, "planner2", QUESTIONNAIRE_FIELDS.planner2);
  planner.providerFamily = requireOne(planner.providerFamily, "planner2.providerFamily", PROVIDER_FAMILIES);
  planner.continuityPolicy = requireOne(planner.continuityPolicy, "planner2.continuityPolicy", PLANNER_CONTINUITY_POLICIES);
  planner.sessionMode = requireOne(planner.sessionMode, "planner2.sessionMode", ["create", "bind_existing"]);
  const worker = normalizeRoleAnswers(executor, "executor", QUESTIONNAIRE_FIELDS.executor);
  worker.providerFamily = requireOne(worker.providerFamily, "executor.providerFamily", PROVIDER_FAMILIES);
  worker.noCommit = requireOne(worker.noCommit, "executor.noCommit", NO_COMMIT_CLASSES);
  worker.sessionScope = requireOne(worker.sessionScope, "executor.sessionScope", EXECUTOR_SESSION_SCOPES);
  const maxCorrections = source.correctionPolicy?.maxCorrections;
  if (!Number.isInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > 3) {
    fail("correctionPolicy.maxCorrections must be an integer from 0 through 3", "E_CONFIG_FIELD");
  }
  const hostWaitCapability = requireOne(source.hostWaitCapability, "hostWaitCapability", ["single_outer_call", "described_equivalent", "unavailable"]);
  const configuredRecordsRoot = source.recordsRoot ?? source.recordsRootOverride ?? recordsRoot;
  const normalizedRecordsRoot = assertRelativeInput(configuredRecordsRoot, "recordsRoot");
  if (normalizedRecordsRoot === ".") fail("recordsRoot must not be the project root", "E_CONFIG_FIELD");
  const requestedRecordsRoot = assertRelativeInput(recordsRoot, "recordsRoot");
  if (normalizedRecordsRoot !== requestedRecordsRoot && requestedRecordsRoot !== DEFAULT_RECORDS_ROOT) {
    fail("recordsRoot is fixed after the initial configuration and cannot be relocated", "E_RECORDS_ROOT_RELOCATION");
  }
  return {
    planningLead,
    planner2: planner,
    executor: worker,
    defaultTimeout: normalizeTimeout(source.defaultTimeout),
    correctionPolicy: { maxCorrections },
    hostWaitCapability,
    recordsRoot: normalizedRecordsRoot,
  };
}

function derivedValues(projectRoot, answers, derivedInput = {}) {
  const envelope = derivedInput.adapterEnvelope ?? null;
  const proposedCwdMode = envelope?.cwdMode ?? derivedInput.proposedCwdMode ?? "unknown";
  const hostWaitCapability = derivedInput.hostWaitCapability ?? answers?.hostWaitCapability ?? "unknown";
  const suspensionStatus = hostWaitCapability === "unavailable" ? "unavailable" : "unknown";
  const roleVocabulary = { "planner-2": "planner", executor: "executor" };
  const dispatchInput = derivedInput.dispatchIdentity ?? null;
  const dispatchIdentity = dispatchInput ? sha256Bytes(stableJson(dispatchInput)) : null;
  const jobKey = derivedInput.jobKey ?? null;
  const attempt = Number.isInteger(derivedInput.attempt) && derivedInput.attempt > 0 ? derivedInput.attempt : 1;
  return {
    repositoryRoot: projectRoot,
    proposedCwdMode,
    roleVocabulary,
    dispatchIdentity,
    idempotencyKey: dispatchIdentity ? `dd:${dispatchIdentity}` : null,
    hashes: {
      configuration: derivedInput.configurationDigest ?? null,
      brief: derivedInput.briefDigest ?? null,
      adapterEnvelope: derivedInput.adapterEnvelopeDigest ?? null,
    },
    artifactPaths: jobKey ? {
      jobKey,
      attempt,
      directory: `${answers.recordsRoot}/runtime/jobs/${jobKey}/attempt-${String(attempt).padStart(2, "0")}`,
    } : null,
    suspensionStatus,
  };
}

export function canonicalRecordBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, "utf8");
}

export function canonicalRecordText(value) {
  return canonicalRecordBytes(value).toString("utf8");
}

export function digestRecordBytes(bytes) {
  return sha256Bytes(bytes);
}

async function writeImmutableJson(root, relative, value, { maxBytes = MAX_RECORD_BYTES } = {}) {
  const bytes = canonicalRecordBytes(value);
  if (bytes.length > maxBytes) return { status: "STOPPED_VERBATIM_TOO_LARGE", path: relative, digest: null, reused: false };
  const digest = digestRecordBytes(bytes);
  try {
    await assertNoReparseCrossing(root, relative, { allowMissing: false, includeFinal: true });
    const existing = await readOwnedFile(root, relative, "immutable JSON record");
    if (Buffer.compare(existing, bytes) === 0) return { status: "REUSED", path: relative, digest, reused: true };
    fail(`immutable record contradiction: existing record has different bytes: ${relative}`, "E_RECORD_CONTRADICTION");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeNewFile(root, relative, bytes);
    return { status: "CREATED", path: relative, digest, reused: false };
  }
}

async function readJsonRecord(root, relative) {
  const bytes = await readOwnedFile(root, relative, "configuration record");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`malformed configuration record: ${error.message}`, "E_RECORD_MALFORMED");
  }
  return { value, bytes, digest: digestRecordBytes(bytes), path: relative };
}

async function recordsRootHasConfiguration(projectRoot, recordsRoot) {
  try {
    await readOwnedFile(projectRoot, configPath(1, recordsRoot), "configuration v1 record");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function configPath(version, recordsRoot = DEFAULT_RECORDS_ROOT) {
  if (!Number.isInteger(version) || version < 1) fail("configuration version must be a positive integer", "E_CONFIG_VERSION");
  const root = assertRelativeInput(recordsRoot, "recordsRoot");
  return `${root}/${CONFIGURATION_DIRECTORY}/configuration.v${version}.json`;
}

function confirmationPath(version, recordsRoot = DEFAULT_RECORDS_ROOT) {
  if (!Number.isInteger(version) || version < 1) fail("configuration version must be a positive integer", "E_CONFIG_VERSION");
  const root = assertRelativeInput(recordsRoot, "recordsRoot");
  return `${root}/${CONFIGURATION_DIRECTORY}/configuration.v${version}.confirmation.json`;
}

export function configurationPath(version, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return configPath(version, recordsRoot);
}

export function configurationConfirmationPath(version, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return confirmationPath(version, recordsRoot);
}

export function validateConfigurationAnswers(input, options = {}) {
  return normalizeAnswers(input, options);
}

export async function createQuestionnaire({ root, recordsRoot = DEFAULT_RECORDS_ROOT, derivedInput = {} } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const normalizedRecordsRoot = assertRelativeInput(recordsRoot, "recordsRoot");
  if (normalizedRecordsRoot === ".") fail("recordsRoot must not be the project root", "E_CONFIG_FIELD");
  const askedFields = {
    planningLead: [...QUESTIONNAIRE_FIELDS.planningLead],
    planner2: [...QUESTIONNAIRE_FIELDS.planner2],
    executor: [...QUESTIONNAIRE_FIELDS.executor],
    scalar: [...QUESTIONNAIRE_FIELDS.scalar],
    conditional: derivedInput.recordsRootRejected ? [...QUESTIONNAIRE_FIELDS.conditional] : [],
  };
  const questions = Object.entries(askedFields).flatMap(([category, fields]) => fields.map((field) => ({
    key: category === "scalar" || category === "conditional" ? field : `${category}.${field}`,
    category,
    responseType: "verbatim-structured-input",
  })));
  return {
    schemaVersion: QUESTIONNAIRE_SCHEMA,
    version: 1,
    askedFields,
    questions,
    derived: derivedValues(projectRoot, { recordsRoot: normalizedRecordsRoot, hostWaitCapability: derivedInput.hostWaitCapability }, derivedInput),
  };
}

export async function createConfigurationDraft({ root, version, answers, recordsRoot = DEFAULT_RECORDS_ROOT, supersedes = null, derivedInput = {} } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const requestedRecordsRoot = assertRelativeInput(recordsRoot, "recordsRoot");
  if (requestedRecordsRoot !== DEFAULT_RECORDS_ROOT && await recordsRootHasConfiguration(projectRoot, DEFAULT_RECORDS_ROOT)) {
    fail("recordsRoot relocation requires a separate migration and is not supported by this runtime", "E_RECORDS_ROOT_RELOCATION");
  }
  const normalizedAnswers = normalizeAnswers(answers, { recordsRoot });
  if (normalizedAnswers.recordsRoot !== requestedRecordsRoot && await recordsRootHasConfiguration(projectRoot, DEFAULT_RECORDS_ROOT)) {
    fail("recordsRoot relocation requires a separate migration and is not supported by this runtime", "E_RECORDS_ROOT_RELOCATION");
  }
  const existingVersions = await listConfigurationVersions(projectRoot, normalizedAnswers.recordsRoot);
  let resolvedVersion = version;
  let resolvedSupersedes = supersedes;
  if (resolvedVersion === undefined || resolvedVersion === null) {
    if (existingVersions.length === 0) {
      resolvedVersion = 1;
    } else {
      const matching = [];
      for (const candidateVersion of existingVersions) {
        const candidate = await loadConfiguration({ root: projectRoot, version: candidateVersion, recordsRoot: normalizedAnswers.recordsRoot });
        if (stableJson(candidate.value.answers) === stableJson(normalizedAnswers)) matching.push(candidate);
      }
      if (matching.length > 0) {
        const latest = matching.at(-1);
        resolvedVersion = latest.value.version;
        resolvedSupersedes = latest.value.supersedes ?? null;
      } else {
        const active = await deriveActiveConfiguration({ root: projectRoot, recordsRoot: normalizedAnswers.recordsRoot });
        if (active.status !== "CONFIRMED" || !active.active) {
          fail("a later configuration requires one confirmed active chain head", "E_CONFIG_CHAIN");
        }
        resolvedVersion = active.active.version + 1;
        resolvedSupersedes ??= active.active.configurationDigest;
      }
    }
  }
  if (resolvedVersion === 1 && resolvedSupersedes !== null) fail("configuration v1 must have supersedes=null", "E_CONFIG_CHAIN");
  if (resolvedVersion > 1 && (typeof resolvedSupersedes !== "string" || !/^[a-f0-9]{64}$/i.test(resolvedSupersedes))) {
    fail("configuration versions after v1 require a supersedes SHA-256 digest", "E_CONFIG_SUPERSEDES");
  }
  if (resolvedSupersedes !== null && !/^[a-f0-9]{64}$/i.test(String(resolvedSupersedes))) fail("supersedes must be a SHA-256 digest or null", "E_CONFIG_SUPERSEDES");
  const record = {
    schemaVersion: PROJECT_CONFIG_SCHEMA,
    version: resolvedVersion,
    lifecycle: "DRAFT",
    answers: normalizedAnswers,
    derived: derivedValues(projectRoot, normalizedAnswers, derivedInput),
    supersedes: resolvedSupersedes ?? null,
  };
  const relative = configPath(resolvedVersion, normalizedAnswers.recordsRoot);
  const written = await writeImmutableJson(projectRoot, relative, record);
  return { ...written, record, projectRoot, recordsRoot: normalizedAnswers.recordsRoot };
}

export const createConfiguration = createConfigurationDraft;
export const buildQuestionnaire = createQuestionnaire;
export const createConfig = createConfigurationDraft;

export async function loadConfiguration({ root, version = 1, recordsRoot = DEFAULT_RECORDS_ROOT } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const relative = configPath(version, recordsRoot);
  const loaded = await readJsonRecord(projectRoot, relative);
  if (loaded.value.schemaVersion !== PROJECT_CONFIG_SCHEMA) fail(`configuration record schema must be ${PROJECT_CONFIG_SCHEMA}`, "E_RECORD_MALFORMED");
  if (loaded.value.version !== version) fail(`configuration record version does not match its path: ${relative}`, "E_CONFIG_CONTRADICTION");
  if (loaded.value.supersedes === undefined) loaded.value.supersedes = null;
  if (loaded.value.answers?.recordsRoot !== assertRelativeInput(recordsRoot, "recordsRoot")) {
    fail(`configuration record changes the fixed recordsRoot: ${relative}`, "E_RECORDS_ROOT_RELOCATION");
  }
  return { ...loaded, projectRoot };
}

export async function confirmConfiguration({ root, version = 1, recordsRoot = DEFAULT_RECORDS_ROOT, configurationDigest, digest, confirmedBy, confirmationSource = "explicit-caller" } = {}) {
  const loaded = await loadConfiguration({ root, version, recordsRoot });
  const expected = configurationDigest ?? digest;
  if (expected !== loaded.digest) fail("configuration confirmation digest does not match the immutable draft", "E_CONFIG_DIGEST");
  requiredText(confirmedBy, "confirmedBy", { max: 256 });
  requiredText(confirmationSource, "confirmationSource", { max: 256 });
  const chain = await confirmedConfigurationChain(loaded.projectRoot, assertRelativeInput(recordsRoot, "recordsRoot"), { candidate: loaded });
  const confirmation = {
    schemaVersion: CONFIG_CONFIRMATION_SCHEMA,
    version,
    lifecycle: "CONFIRMED",
    configurationPath: loaded.path,
    configurationDigest: loaded.digest,
    confirmedBy,
    confirmationSource,
    supersedes: loaded.value.supersedes ?? null,
  };
  const relative = confirmationPath(version, recordsRoot);
  const existing = chain.confirmed.find((item) => item.version === version);
  if (existing) {
    validateConfirmedChain(chain);
    const existingBytes = canonicalRecordBytes(existing.confirmation);
    if (Buffer.compare(existingBytes, canonicalRecordBytes(confirmation)) !== 0) fail(`configuration confirmation already exists with contradictory bytes: ${relative}`, "E_RECORD_CONTRADICTION");
    return { status: "REUSED", path: existing.confirmationPath, digest: existing.confirmationDigest, confirmation: existing.confirmation, configuration: loaded.value, projectRoot: loaded.projectRoot, reused: true };
  }
  validateCandidateConfirmation(chain, loaded);
  const written = await writeImmutableJson(loaded.projectRoot, relative, confirmation);
  return { ...written, confirmation, configuration: loaded.value, projectRoot: loaded.projectRoot };
}

export const confirmConfigurationVersion = confirmConfiguration;
export const confirmConfig = confirmConfiguration;

async function listConfigurationVersions(projectRoot, recordsRoot) {
  const directoryRelative = `${assertRelativeInput(recordsRoot, "recordsRoot")}/${CONFIGURATION_DIRECTORY}`;
  const directory = absoluteFromRelative(projectRoot, directoryRelative);
  try {
    await assertNoReparseCrossing(projectRoot, directoryRelative, { allowMissing: false, includeFinal: true });
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^configuration\.v\d+\.json$/i.test(entry.name))
      .map((entry) => Number(entry.name.match(/\.v(\d+)\.json$/i)[1]))
      .sort((a, b) => a - b);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function confirmedConfigurationChain(projectRoot, recordsRoot, { candidate = null } = {}) {
  const versions = await listConfigurationVersions(projectRoot, recordsRoot);
  const confirmed = [];
  for (const version of versions) {
    const loaded = await loadConfiguration({ root: projectRoot, version, recordsRoot });
    const confirmationRelative = confirmationPath(version, recordsRoot);
    let confirmation;
    try {
      confirmation = await readJsonRecord(projectRoot, confirmationRelative, "configuration confirmation record");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (confirmation.value.schemaVersion !== CONFIG_CONFIRMATION_SCHEMA || confirmation.value.version !== version || confirmation.value.configurationPath !== loaded.path || confirmation.value.configurationDigest !== loaded.digest || (confirmation.value.supersedes ?? null) !== (loaded.value.supersedes ?? null)) {
      fail(`configuration confirmation contradicts configuration v${version}`, "E_CONFIG_CONTRADICTION");
    }
    confirmed.push({ version, configuration: loaded.value, configurationPath: loaded.path, configurationDigest: loaded.digest, confirmation: confirmation.value, confirmationPath: confirmation.path, confirmationDigest: confirmation.digest });
  }
  const candidateItem = candidate ? {
    version: candidate.value.version,
    configuration: candidate.value,
    configurationPath: candidate.path,
    configurationDigest: candidate.digest,
    confirmation: null,
    confirmationPath: null,
    confirmationDigest: null,
  } : null;
  return { confirmed, candidate: candidateItem, recordsRoot };
}

function validateConfirmedChain(chain, { includeCandidate = false } = {}) {
  const items = [...chain.confirmed];
  if (includeCandidate && chain.candidate) items.push(chain.candidate);
  const byDigest = new Map(items.map((item) => [item.configurationDigest, item]));
  const byVersion = new Map(items.map((item) => [item.version, item]));
  if (byVersion.size !== items.length) fail("configuration chain contains duplicate versions", "E_CONFIG_CONTRADICTION");
  const children = new Map();
  for (const item of items) {
    const supersedes = item.configuration.supersedes ?? null;
    if (item.version === 1) {
      if (supersedes !== null) fail("configuration v1 must have supersedes=null", "E_CONFIG_CONTRADICTION");
      continue;
    }
    if (typeof supersedes !== "string" || !/^[a-f0-9]{64}$/i.test(supersedes)) fail(`configuration v${item.version} has no valid supersedes digest`, "E_CONFIG_CONTRADICTION");
    const parent = byDigest.get(supersedes);
    if (!parent || parent.version >= item.version || parent.version !== item.version - 1) fail(`configuration v${item.version} has a dangling, backward, or non-linear supersedes reference`, "E_CONFIG_CONTRADICTION");
    const priorChildren = children.get(supersedes) ?? [];
    priorChildren.push(item);
    children.set(supersedes, priorChildren);
  }
  for (const [digest, descendants] of children) {
    if (descendants.length > 1) fail(`configuration chain has multiple confirmed children for ${digest}`, "E_CONFIG_CONTRADICTION");
  }
  const heads = items.filter((item) => !children.has(item.configurationDigest));
  if (heads.length > 1) fail("configuration chain has more than one unsuperseded confirmed head", "E_CONFIG_CONTRADICTION");
  return { items, head: heads[0] ?? null, children };
}

function validateCandidateConfirmation(chain, loaded) {
  if (loaded.value.version === 1) {
    if (loaded.value.supersedes !== null || chain.confirmed.length > 0) fail("configuration v1 cannot be confirmed into an existing chain", "E_CONFIG_CONTRADICTION");
    return;
  }
  const existing = validateConfirmedChain(chain);
  if (!existing.head) fail("a later configuration requires an earlier confirmed active head", "E_CONFIG_CHAIN");
  if (loaded.value.version !== existing.head.version + 1 || loaded.value.supersedes !== existing.head.configurationDigest) {
    fail("configuration draft is stale or does not supersede the current confirmed head", "E_CONFIG_CHAIN");
  }
  validateConfirmedChain({ ...chain, candidate: { version: loaded.value.version, configuration: loaded.value, configurationPath: loaded.path, configurationDigest: loaded.digest } }, { includeCandidate: true });
}

export async function deriveActiveConfiguration({ root, recordsRoot = DEFAULT_RECORDS_ROOT } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const normalizedRecordsRoot = assertRelativeInput(recordsRoot, "recordsRoot");
  if (normalizedRecordsRoot !== DEFAULT_RECORDS_ROOT && await recordsRootHasConfiguration(projectRoot, DEFAULT_RECORDS_ROOT)) {
    fail("recordsRoot relocation requires a separate migration and is not supported by this runtime", "E_RECORDS_ROOT_RELOCATION");
  }
  const chain = await confirmedConfigurationChain(projectRoot, normalizedRecordsRoot);
  if (chain.confirmed.length === 0) return { status: "UNCONFIRMED", active: null, configurations: [] };
  const validated = validateConfirmedChain(chain);
  const supersededDigests = chain.confirmed.filter((item) => item !== validated.head).map((item) => item.configurationDigest);
  return { status: validated.head ? "CONFIRMED" : "CONTRADICTORY", active: validated.head, configurations: chain.confirmed, supersededDigests };
}

export const activeConfiguration = deriveActiveConfiguration;
export const getActiveConfiguration = deriveActiveConfiguration;

export function configurationForbiddenKeys() {
  return [...AUTHORITY_KEYS];
}
