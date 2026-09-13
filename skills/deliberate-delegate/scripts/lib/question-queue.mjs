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
  writeNewFile,
} from "./lifecycle-core.mjs";
import { DEFAULT_RECORDS_ROOT, MAX_RECORD_BYTES, canonicalRecordBytes, digestRecordBytes } from "./project-config.mjs";

export const QUESTION_SCHEMA = "dd.question.v1";
export const ANSWER_SCHEMA = "dd.answer.v1";
export const WITHDRAWAL_SCHEMA = "dd.question-withdrawal.v1";
export const QUESTION_MAX_BYTES = MAX_RECORD_BYTES;
export const QUESTION_TERMINAL_FILE = "terminal.json";

function requiredText(value, label, max = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${label} must be a non-empty string of at most ${max} characters`, "E_QUESTION_FIELD");
  return value;
}

export function normalizeQuestionKey(value) {
  const key = requiredText(value, "questionKey", 512);
  if (key === "." || key === ".." || /[\u0000-\u001f\u007f]/.test(key)) fail("questionKey contains an invalid control character", "E_QUESTION_KEY");
  return key;
}

function questionKeyDigest(value) {
  return sha256Bytes(normalizeQuestionKey(value));
}

export function questionDirectoryIdentity(questionKey) {
  return questionKeyDigest(questionKey);
}

function normalizedRecordsRoot(recordsRoot = DEFAULT_RECORDS_ROOT) {
  const root = assertRelativeInput(recordsRoot, "recordsRoot");
  if (root === ".") fail("recordsRoot must not be the project root", "E_QUESTION_FIELD");
  return root;
}

function questionDirectory(questionKey, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return `${normalizedRecordsRoot(recordsRoot)}/runtime/questions/${questionKeyDigest(questionKey)}`;
}

export function questionRecordPath(questionKey, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return `${questionDirectory(questionKey, recordsRoot)}/question.json`;
}

export function answerRecordPath(questionKey, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return `${questionDirectory(questionKey, recordsRoot)}/${QUESTION_TERMINAL_FILE}`;
}

export function withdrawalRecordPath(questionKey, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return answerRecordPath(questionKey, recordsRoot);
}

function legacyAnswerRecordPath(questionKey, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return `${questionDirectory(questionKey, recordsRoot)}/answer.json`;
}

function legacyWithdrawalRecordPath(questionKey, recordsRoot = DEFAULT_RECORDS_ROOT) {
  return `${questionDirectory(questionKey, recordsRoot)}/withdrawal.json`;
}

function compareBytes(left, right) {
  return Buffer.compare(left, right) === 0;
}

async function writeImmutableVerbatim(root, relative, value) {
  const bytes = canonicalRecordBytes(value);
  if (bytes.byteLength > QUESTION_MAX_BYTES) return { status: "STOPPED_VERBATIM_TOO_LARGE", path: relative, digest: null, reused: false };
  const digest = digestRecordBytes(bytes);
  try {
    await assertNoReparseCrossing(root, relative, { allowMissing: false, includeFinal: true });
    const existing = await readOwnedFile(root, relative, "verbatim record");
    if (compareBytes(existing, bytes)) return { status: "REUSED", path: relative, digest, reused: true };
    fail(`verbatim record already exists with contradictory bytes: ${relative}`, "E_QUESTION_CONTRADICTION");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeNewFile(root, relative, bytes);
    return { status: "CREATED", path: relative, digest, reused: false };
  }
}

async function writeExclusiveTerminal(root, relative, value) {
  const bytes = canonicalRecordBytes(value);
  if (bytes.byteLength > QUESTION_MAX_BYTES) return { status: "STOPPED_VERBATIM_TOO_LARGE", path: relative, digest: null, reused: false };
  const digest = digestRecordBytes(bytes);
  try {
    await writeNewFile(root, relative, bytes);
    return { status: "CREATED", path: relative, digest, reused: false };
  } catch (error) {
    if (error.code !== "E_OUTPUT_COLLISION") throw error;
    const existing = await readOwnedFile(root, relative, "question terminal record");
    if (compareBytes(existing, bytes)) return { status: "REUSED", path: relative, digest, reused: true };
    fail(`question terminal transition already won with contradictory bytes: ${relative}`, "E_QUESTION_CONTRADICTION");
  }
}

async function readJson(root, relative, label) {
  const bytes = await readOwnedFile(root, relative, label);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes, digest: sha256Bytes(bytes), path: relative };
  } catch (error) {
    fail(`malformed ${label}: ${error.message}`, "E_RECORD_MALFORMED");
  }
}

async function readOptionalJson(root, relative, label) {
  try {
    return await readJson(root, relative, label);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { error };
  }
}

function phaseReference(value, label) {
  if (value === undefined || value === null) return null;
  return requiredText(value, label, 256);
}

function normalizedScope(input = {}) {
  const phaseId = phaseReference(input.phaseId ?? input.phaseKey, "phaseId");
  const workPackageId = phaseReference(input.workPackageId ?? input.workPackageKey, "workPackageId");
  if (workPackageId !== null && phaseId === null) fail("workPackageId requires a phaseId", "E_QUESTION_SCOPE");
  return { phaseId, workPackageId };
}

function questionScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { phaseKey: null, workPackageKey: null, valid: false };
  const phaseKey = value.phaseId ?? value.phaseKey ?? null;
  const workPackageKey = value.workPackageId ?? value.workPackageKey ?? null;
  const valid = (phaseKey === null || typeof phaseKey === "string") && (workPackageKey === null || typeof workPackageKey === "string") && !(workPackageKey !== null && phaseKey === null);
  return { phaseKey, workPackageKey, valid };
}

function questionRecordValid(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.schemaVersion !== QUESTION_SCHEMA || value.questionKey !== key) return false;
  if (typeof value.questionText !== "string" || typeof value.intendedRespondent !== "string" || typeof value.reason !== "string") return false;
  return questionScope(value).valid;
}

function terminalState(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.questionKey !== key) return null;
  if (value.schemaVersion === ANSWER_SCHEMA && value.terminalState === "ANSWERED" && value.source === "human_input" && typeof value.answer === "string") return "ANSWERED";
  if (value.schemaVersion === WITHDRAWAL_SCHEMA && value.terminalState === "WITHDRAWN" && typeof value.reason === "string") return "WITHDRAWN";
  return null;
}

function scopeFromRecord(value) {
  const scope = questionScope(value);
  return scope.valid ? { phaseKey: scope.phaseKey, workPackageKey: scope.workPackageKey } : { phaseKey: null, workPackageKey: null };
}

async function loadQuestionRecord(root, key, recordsRoot) {
  const question = await readJson(root, questionRecordPath(key, recordsRoot), "question record");
  if (!questionRecordValid(question.value, key)) fail("question record is malformed or contradicts its key", "E_RECORD_MALFORMED");
  return question;
}

async function legacyTerminalState(root, key, recordsRoot) {
  const answer = await readOptionalJson(root, legacyAnswerRecordPath(key, recordsRoot), "legacy answer record");
  const withdrawal = await readOptionalJson(root, legacyWithdrawalRecordPath(key, recordsRoot), "legacy withdrawal record");
  if (answer?.error || withdrawal?.error) return { contradiction: true, reason: "a legacy question terminal record is malformed" };
  if (answer && withdrawal) return { contradiction: true, reason: "legacy question has both answer and withdrawal records" };
  if (answer && (answer.value.schemaVersion !== ANSWER_SCHEMA || answer.value.questionKey !== key || answer.value.source !== "human_input" || typeof answer.value.answer !== "string")) return { contradiction: true, reason: "legacy answer record is malformed or contradicts its key" };
  if (withdrawal && (withdrawal.value.schemaVersion !== WITHDRAWAL_SCHEMA || withdrawal.value.questionKey !== key || typeof withdrawal.value.reason !== "string")) return { contradiction: true, reason: "legacy withdrawal record is malformed or contradicts its key" };
  if (answer) return { state: "ANSWERED", answer };
  if (withdrawal) return { state: "WITHDRAWN", withdrawal };
  return { state: "OPEN" };
}

async function existingTerminal(root, key, recordsRoot) {
  const relative = answerRecordPath(key, recordsRoot);
  const terminal = await readOptionalJson(root, relative, "question terminal record");
  if (terminal?.error) return { contradiction: true, reason: "question terminal record is malformed", terminal };
  if (terminal) {
    const state = terminalState(terminal.value, key);
    if (!state) return { contradiction: true, reason: "question terminal record is malformed or contradicts its key", terminal };
    return { state, terminal };
  }
  return legacyTerminalState(root, key, recordsRoot);
}

export async function openQuestion({ root, questionKey, text, questionText, intendedRespondent, reason, phaseId, phaseKey, workPackageId, workPackageKey, recordsRoot = DEFAULT_RECORDS_ROOT } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const key = normalizeQuestionKey(questionKey);
  const completeText = text ?? questionText;
  requiredText(completeText, "question text", Number.MAX_SAFE_INTEGER);
  const scope = normalizedScope({ phaseId: phaseId ?? phaseKey, workPackageId: workPackageId ?? workPackageKey });
  const record = {
    schemaVersion: QUESTION_SCHEMA,
    questionKey: key,
    questionText: completeText,
    intendedRespondent: requiredText(intendedRespondent, "intendedRespondent", 256),
    reason: requiredText(reason, "reason", 4096),
    ...scope,
  };
  const written = await writeImmutableVerbatim(projectRoot, questionRecordPath(key, recordsRoot), record);
  return { ...written, projectRoot, record, complete: written.status !== "STOPPED_VERBATIM_TOO_LARGE" };
}

export async function answerQuestion({ root, questionKey, answer, answerText, recordsRoot = DEFAULT_RECORDS_ROOT, source = "human_input" } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const key = normalizeQuestionKey(questionKey);
  const question = await loadQuestionRecord(projectRoot, key, recordsRoot);
  if (source !== "human_input") fail("answer source must identify human input", "E_QUESTION_SOURCE");
  const completeText = answer ?? answerText;
  requiredText(completeText, "answer text", Number.MAX_SAFE_INTEGER);
  const record = { schemaVersion: ANSWER_SCHEMA, terminalState: "ANSWERED", questionKey: key, answer: completeText, source: "human_input" };
  const existing = await existingTerminal(projectRoot, key, recordsRoot);
  if (existing.contradiction) fail(existing.reason, "E_QUESTION_CONTRADICTION");
  if (existing.state === "WITHDRAWN") fail("a question cannot have both an answer and a withdrawal", "E_QUESTION_CONTRADICTION");
  if (existing.state === "ANSWERED") {
    const current = existing.terminal ?? existing.answer;
    if (current && ((current.value?.answer === completeText && current.value?.source === "human_input") || Buffer.compare(current.bytes, canonicalRecordBytes(record)) === 0)) return { status: "REUSED", path: current.path, digest: current.digest, reused: true, projectRoot, record, questionPath: question.path, questionDigest: question.digest, complete: true };
    fail("question already has a contradictory answer", "E_QUESTION_CONTRADICTION");
  }
  const written = await writeExclusiveTerminal(projectRoot, answerRecordPath(key, recordsRoot), record);
  return { ...written, projectRoot, record, questionPath: question.path, questionDigest: question.digest, complete: written.status !== "STOPPED_VERBATIM_TOO_LARGE" };
}

export async function withdrawQuestion({ root, questionKey, reason, withdrawalReason, recordsRoot = DEFAULT_RECORDS_ROOT } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const key = normalizeQuestionKey(questionKey);
  const question = await loadQuestionRecord(projectRoot, key, recordsRoot);
  const completeReason = withdrawalReason ?? reason;
  requiredText(completeReason, "withdrawal reason", Number.MAX_SAFE_INTEGER);
  const record = { schemaVersion: WITHDRAWAL_SCHEMA, terminalState: "WITHDRAWN", questionKey: key, reason: completeReason };
  const existing = await existingTerminal(projectRoot, key, recordsRoot);
  if (existing.contradiction) fail(existing.reason, "E_QUESTION_CONTRADICTION");
  if (existing.state === "ANSWERED") fail("a question cannot have both an answer and a withdrawal", "E_QUESTION_CONTRADICTION");
  if (existing.state === "WITHDRAWN") {
    const current = existing.terminal ?? existing.withdrawal;
    if (current && ((current.value?.reason === completeReason) || Buffer.compare(current.bytes, canonicalRecordBytes(record)) === 0)) return { status: "REUSED", path: current.path, digest: current.digest, reused: true, projectRoot, record, questionPath: question.path, questionDigest: question.digest, complete: true };
    fail("question already has a contradictory withdrawal", "E_QUESTION_CONTRADICTION");
  }
  const written = await writeExclusiveTerminal(projectRoot, withdrawalRecordPath(key, recordsRoot), record);
  return { ...written, projectRoot, record, questionPath: question.path, questionDigest: question.digest, complete: written.status !== "STOPPED_VERBATIM_TOO_LARGE" };
}

async function inspectQuestionDirectory(projectRoot, recordsRoot, directoryName) {
  const relative = `${normalizedRecordsRoot(recordsRoot)}/runtime/questions/${directoryName}`;
  const absolute = absoluteFromRelative(projectRoot, relative);
  const question = await readOptionalJson(projectRoot, `${relative}/question.json`, "question record");
  const questionValue = question?.error ? null : question?.value;
  const questionKey = typeof questionValue?.questionKey === "string" ? questionValue.questionKey : null;
  const scope = scopeFromRecord(questionValue);
  const errors = [];
  if (!question || question.error) errors.push(question?.error?.message ?? "question directory has no question.json");
  else if (!questionRecordValid(question.value, questionKey)) errors.push("question record is malformed or contradicts its key");
  else if (questionKeyDigest(questionKey) !== directoryName) errors.push("question directory identity does not match questionKey");
  const terminal = await readOptionalJson(projectRoot, `${relative}/${QUESTION_TERMINAL_FILE}`, "question terminal record");
  const legacyAnswer = await readOptionalJson(projectRoot, `${relative}/answer.json`, "legacy answer record");
  const legacyWithdrawal = await readOptionalJson(projectRoot, `${relative}/withdrawal.json`, "legacy withdrawal record");
  if (terminal?.error) errors.push(terminal.error.message);
  if (legacyAnswer?.error) errors.push(legacyAnswer.error.message);
  if (legacyWithdrawal?.error) errors.push(legacyWithdrawal.error.message);
  if (terminal && !terminal.error && !terminalState(terminal.value, questionKey)) errors.push("question terminal record is malformed or contradicts its key");
  if (legacyAnswer && !legacyAnswer.error && (legacyAnswer.value.schemaVersion !== ANSWER_SCHEMA || legacyAnswer.value.questionKey !== questionKey || legacyAnswer.value.source !== "human_input" || typeof legacyAnswer.value.answer !== "string")) errors.push("legacy answer record is malformed or contradicts its key");
  if (legacyWithdrawal && !legacyWithdrawal.error && (legacyWithdrawal.value.schemaVersion !== WITHDRAWAL_SCHEMA || legacyWithdrawal.value.questionKey !== questionKey || typeof legacyWithdrawal.value.reason !== "string")) errors.push("legacy withdrawal record is malformed or contradicts its key");
  if (terminal && (legacyAnswer || legacyWithdrawal)) errors.push("question has canonical and legacy terminal records simultaneously");
  if (legacyAnswer && legacyWithdrawal) errors.push("question has both answer and withdrawal records");
  const terminalKind = terminal && !terminal.error ? terminalState(terminal.value, questionKey) : null;
  const legacyKind = legacyAnswer ? "ANSWERED" : legacyWithdrawal ? "WITHDRAWN" : null;
  const state = errors.length > 0 ? "CONTRADICTORY" : terminalKind ?? legacyKind ?? "OPEN";
  const records = {
    ...(question && !question.error ? { question: { path: question.path, digest: question.digest, value: question.value } } : {}),
    ...(terminal && !terminal.error ? { terminal: { path: terminal.path, digest: terminal.digest, value: terminal.value } } : {}),
    ...(legacyAnswer && !legacyAnswer.error ? { answer: { path: legacyAnswer.path, digest: legacyAnswer.digest, value: legacyAnswer.value } } : {}),
    ...(legacyWithdrawal && !legacyWithdrawal.error ? { withdrawal: { path: legacyWithdrawal.path, digest: legacyWithdrawal.digest, value: legacyWithdrawal.value } } : {}),
  };
  return {
    questionKey,
    state,
    stopCode: state === "CONTRADICTORY" ? "STOPPED_QUESTION_CONTRADICTION" : null,
    reason: errors.join("; ") || null,
    scope,
    question: records.question ?? null,
    terminal: records.terminal ?? null,
    answer: terminalKind === "ANSWERED" ? records.terminal : records.answer ?? null,
    withdrawal: terminalKind === "WITHDRAWN" ? records.terminal : records.withdrawal ?? null,
    records,
    directory: relative,
    absolute,
  };
}

export async function inspectQuestion({ root, questionKey, recordsRoot = DEFAULT_RECORDS_ROOT } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const key = normalizeQuestionKey(questionKey);
  const relative = questionDirectory(key, recordsRoot);
  await assertNoReparseCrossing(projectRoot, relative, { allowMissing: false, includeFinal: true });
  const inspected = await inspectQuestionDirectory(projectRoot, recordsRoot, path.posix.basename(relative));
  return inspected;
}

export async function listQuestions({ root, recordsRoot = DEFAULT_RECORDS_ROOT } = {}) {
  const projectRoot = await realDirectory(root, "root");
  const relative = `${normalizedRecordsRoot(recordsRoot)}/runtime/questions`;
  const absolute = absoluteFromRelative(projectRoot, relative);
  try {
    await assertNoReparseCrossing(projectRoot, relative, { allowMissing: false, includeFinal: true });
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) fail(`question directory contains a reparse point: ${entry.name}`, "E_SYMLINK");
      if (!entry.isDirectory()) continue;
      const stat = await inspectQuestionDirectory(projectRoot, recordsRoot, entry.name);
      result.push({
        questionKey: stat.questionKey,
        state: stat.state,
        stopCode: stat.stopCode,
        reason: stat.reason,
        phaseKey: stat.scope.phaseKey,
        workPackageKey: stat.scope.workPackageKey,
        records: Object.fromEntries(Object.entries(stat.records).map(([name, value]) => [name, { path: value.path, digest: value.digest }])),
      });
    }
    return result;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function questionApplies(question, { phaseKey = null, workPackageKey = null } = {}) {
  if (question?.state !== "OPEN" && question?.state !== "CONTRADICTORY") return false;
  const qPhase = question?.phaseKey ?? null;
  const qWorkPackage = question?.workPackageKey ?? null;
  if (qWorkPackage !== null && qPhase === null) return true;
  if (qPhase === null) return true;
  if (phaseKey === null || phaseKey === undefined) return false;
  if (qPhase !== phaseKey) return false;
  return qWorkPackage === null || qWorkPackage === workPackageKey;
}

export const answer = answerQuestion;
export const open = openQuestion;
export const withdraw = withdrawQuestion;
