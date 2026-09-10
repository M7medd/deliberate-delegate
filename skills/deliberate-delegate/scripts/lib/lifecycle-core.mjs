import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Shared, dependency-free lifecycle mechanics for the Lead-side helper and
 * the awaitable job path.  This module deliberately contains no planner,
 * provider, authorization, or retry decisions.
 */

export const SUMMARY_SCHEMA = "dd-efficiency.summary.v1";
export const SNAPSHOT_SCHEMA = "dd-efficiency.snapshot.v1";
export const DEFAULT_SUMMARY_BYTES = 8 * 1024;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const OUTPUT_PREVIEW_BYTES = 4096;
export const LOG_DRAIN_TIMEOUT_MS = 5000;
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "timeout",
  "timed_out",
  "cancelled",
  "canceled",
  "stopped",
  "error",
]);
export const NONTERMINAL_STATUSES = new Set([
  "pending",
  "running",
  "started",
  "dispatched",
  "in_progress",
  "queued",
]);

export const DEFAULT_CORRECTION_ATTEMPTS = 2;
export const ABSOLUTE_CORRECTION_CEILING = 3;

export function fail(message, code = "E_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function posixPath(value) {
  return String(value).replaceAll("\\", "/");
}

export function isAbsoluteAny(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function assertRelativeInput(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty project-relative path`);
  }
  const normalized = posixPath(value);
  if (normalized.split("/").some((part) => part.toLowerCase() === ".git")) {
    fail(`${label} must not target Git metadata`, "E_PATH_ESCAPE");
  }
  if (isAbsoluteAny(value) || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0") || (process.platform === "win32" && normalized !== "." && /[:]|[. ](?:\/|$)/.test(normalized.replace(/^\.\//, "")))) {
    fail(`${label} must not be absolute or contain path traversal: ${value}`, "E_PATH_TRAVERSAL");
  }
  return path.posix.normalize(normalized);
}

export async function realDirectory(input, label = "root") {
  const candidate = path.resolve(input || process.cwd());
  let real;
  try {
    real = await fsp.realpath(candidate);
  } catch (error) {
    fail(`${label} does not exist: ${candidate}`, "E_ROOT");
  }
  const stat = await fsp.lstat(real);
  if (!stat.isDirectory()) fail(`${label} is not a directory: ${candidate}`, "E_ROOT");
  return real;
}

export function absoluteFromRelative(root, relative) {
  return path.join(root, ...posixPath(relative).split("/"));
}

export function assertInside(root, absolute, label = "path") {
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || isAbsoluteAny(relative)) {
    fail(`${label} escapes the project root: ${absolute}`, "E_PATH_ESCAPE");
  }
}

export async function assertNoReparseCrossing(root, relative, { allowMissing = true, includeFinal = true } = {}) {
  const rel = assertRelativeInput(relative, "path");
  const parts = rel.split("/").filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissing) return;
      throw error;
    }
    if (stat.isSymbolicLink() && (includeFinal || index < parts.length - 1)) {
      fail(`symlink/reparse crossing is not allowed for owned path: ${relative}`, "E_SYMLINK");
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail(`owned path parent is not a directory: ${relative}`, "E_PATH_PARENT");
    }
  }
}

export async function ensureParent(root, relative) {
  const rel = assertRelativeInput(relative, "output path");
  const parent = posixPath(path.posix.dirname(rel));
  if (parent === "." || parent === "") return;
  const parts = parent.split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fsp.mkdir(current);
      stat = await fsp.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`owned output parent crosses a symlink or is not a directory: ${parent}`, "E_SYMLINK");
    }
  }
}

export async function createFreshDirectory(root, relative) {
  const rel = assertRelativeInput(relative, "artifact directory");
  if (rel === "." || rel === "") fail("artifact directory may not be the project root", "E_PATH_ESCAPE");
  const absolute = absoluteFromRelative(root, rel);
  assertInside(root, absolute, "artifact directory");
  await ensureParent(root, rel);
  try {
    await fsp.lstat(absolute);
    fail(`output collision: artifact directory already exists: ${rel}`, "E_OUTPUT_COLLISION");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fsp.mkdir(absolute);
  const stat = await fsp.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`artifact directory is not owned: ${rel}`, "E_SYMLINK");
  return absolute;
}

export async function writeNewFile(root, relative, data) {
  const rel = assertRelativeInput(relative, "output path");
  const absolute = absoluteFromRelative(root, rel);
  assertInside(root, absolute, "output path");
  await ensureParent(root, rel);
  try {
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink()) fail(`refusing to overwrite symlink: ${rel}`, "E_SYMLINK");
    fail(`output collision: file already exists: ${rel}`, "E_OUTPUT_COLLISION");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fsp.writeFile(absolute, data, { flag: "wx" });
  return absolute;
}

export async function readOwnedFile(root, relative, label = "file") {
  const rel = assertRelativeInput(relative, label);
  await assertNoReparseCrossing(root, rel, { allowMissing: false, includeFinal: true });
  const absolute = absoluteFromRelative(root, rel);
  const stat = await fsp.lstat(absolute);
  if (!stat.isFile()) fail(`${label} is not a regular file: ${rel}`, "E_FILE");
  return fsp.readFile(absolute);
}

export function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function hashRegularFile(absolute) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absolute);
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { digest: hash.digest("hex"), size };
}

export async function fingerprint(root, relative) {
  const rel = assertRelativeInput(relative, "inventory path");
  const parts = rel.split("/").filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return { kind: "missing" };
      return { kind: "error", error: `${error.code || "read"}: ${error.message}` };
    }
    if (stat.isSymbolicLink()) {
      let target = "";
      try {
        target = await fsp.readlink(current);
      } catch (error) {
        return { kind: "error", error: `${error.code || "readlink"}: ${error.message}` };
      }
      return { kind: "symlink", target, digest: sha256Bytes(`symlink\0${target}`) };
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      return { kind: "error", error: "path component is not a directory" };
    }
    if (index === parts.length - 1) {
      if (stat.isDirectory()) return { kind: "directory" };
      if (!stat.isFile()) return { kind: "special" };
      try {
        const hashed = await hashRegularFile(current);
        return { kind: "file", ...hashed, mode: stat.mode };
      } catch (error) {
        return { kind: "error", error: `${error.code || "read"}: ${error.message}` };
      }
    }
  }
  return { kind: "missing" };
}

export function fingerprintsEqual(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "file") return left.digest === right.digest && left.size === right.size && left.mode === right.mode;
  if (left.kind === "symlink") return left.digest === right.digest && left.target === right.target;
  if (left.kind === "error") return left.error === right.error;
  return true;
}

export async function drainLogs(logs, streams, timeoutMs = LOG_DRAIN_TIMEOUT_MS) {
  let timer;
  const timedOut = await Promise.race([
    Promise.all(logs).then(() => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    for (const stream of streams) stream.destroy();
    await Promise.all(logs);
  }
  return timedOut;
}

export async function runCapture(command, args, { cwd, stdoutPath, stderrPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const stdout = fs.createWriteStream(stdoutPath, { flags: "wx" });
  const stderr = fs.createWriteStream(stderrPath, { flags: "wx" });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutPreview = [];
  const stderrPreview = [];
  let timedOut = false;
  let killRequested = false;
  let spawnError = null;
  const started = Date.now();

  const child = spawn(command, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const collect = (stream, destination, preview, which) => {
    let seen = 0;
    stream.on("data", (chunk) => {
      const bytes = chunk.length;
      if (which === "stdout") stdoutBytes += bytes;
      else stderrBytes += bytes;
      if (seen < OUTPUT_PREVIEW_BYTES) {
        const kept = chunk.subarray(0, OUTPUT_PREVIEW_BYTES - seen);
        preview.push(kept);
        seen += kept.length;
      }
    });
    return pipeline(stream, destination).catch((error) => {
      spawnError = { code: error.code || null, message: `log capture: ${error.message}` };
      child.kill();
    });
  };
  const logs = [collect(child.stdout, stdout, stdoutPreview, "stdout"), collect(child.stderr, stderr, stderrPreview, "stderr")];

  const result = await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    child.once("error", (error) => {
      spawnError = { code: error.code || null, message: error.message };
      finish({ code: null, signal: null, timedOut, killRequested });
    });
    // exit proves that the owned process finished; close may wait on descendant pipes.
    child.once("exit", (code, signal) => finish({ code, signal, timedOut, killRequested }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          killRequested = child.kill("SIGKILL");
        } catch (error) {
          killRequested = false;
          spawnError = { code: error.code || null, message: error.message };
        }
      }, timeoutMs);
    }
  });

  const logDrainTimedOut = await drainLogs(logs, [child.stdout, child.stderr, stdout, stderr]);
  return {
    ...result,
    spawnError,
    logDrainTimedOut,
    stdoutBytes,
    stderrBytes,
    stdoutPreview: Buffer.concat(stdoutPreview).toString("utf8"),
    stderrPreview: Buffer.concat(stderrPreview).toString("utf8"),
    durationMs: Date.now() - started,
    processTreeTermination: process.platform === "win32" ? "child-only; descendants are not guaranteed terminated" : "child-only",
  };
}

export function boundedItems(items, rawLocator, maxItems = 32, maxChars = 3500) {
  const values = [...items];
  const kept = [];
  let chars = 0;
  for (const item of values) {
    const text = typeof item === "string" ? item : JSON.stringify(item);
    if (kept.length >= maxItems || chars + text.length > maxChars) break;
    kept.push(item);
    chars += text.length;
  }
  return {
    items: kept,
    omittedCount: values.length - kept.length,
    ...(values.length > kept.length ? { rawLocator } : {}),
  };
}

export function summaryWithinLimit(summary, maxBytes = DEFAULT_SUMMARY_BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 512) fail("summary byte limit must be an integer >= 512", "E_SUMMARY_LIMIT");
  const initial = JSON.stringify(summary);
  if (Buffer.byteLength(initial, "utf8") <= maxBytes) return { summary, text: initial };
  const copy = JSON.parse(JSON.stringify(summary));
  const trimArray = (holder, key) => {
    if (holder?.[key] && holder[key].length > 4) {
      const all = holder[key];
      holder[key] = all.slice(0, 4);
      holder.omittedCount = (holder.omittedCount || 0) + all.length - 4;
    }
  };
  trimArray(copy.unexpectedPaths, "items");
  trimArray(copy.diagnostics, "items");
  trimArray(copy.unchangedExistingDirty, "items");
  if (Array.isArray(copy.rawPaths)) copy.rawPaths = copy.rawPaths.slice(0, 8);
  if (Array.isArray(copy.coverageLimits)) copy.coverageLimits = copy.coverageLimits.slice(0, 3);
  if (Array.isArray(copy.validators)) copy.validators = copy.validators.map((item) => ({
    name: item.name,
    status: item.status,
    exitCode: item.exitCode,
    stdoutPath: item.stdoutPath,
    stderrPath: item.stderrPath,
    stdoutBytes: item.stdoutBytes,
    stderrBytes: item.stderrBytes,
    logDrainTimedOut: item.logDrainTimedOut,
  }));
  let text = JSON.stringify(copy);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { summary: copy, text };
  const minimal = {
    schemaVersion: SUMMARY_SCHEMA,
    command: summary.command,
    status: summary.status,
    sessionVerification: summary.sessionVerification,
    summaryPath: summary.summaryPath,
    detailsPath: summary.detailsPath,
    counts: summary.counts,
    coverageLimits: summary.coverageLimits,
    unexpectedPaths: { items: [], omittedCount: summary.counts?.unexpected || 0, rawLocator: summary.unexpectedPaths?.rawLocator },
    diagnostics: { items: [], omittedCount: summary.counts?.diagnostics || 0, rawLocator: summary.diagnostics?.rawLocator },
    rawPaths: summary.rawPaths,
  };
  text = JSON.stringify(minimal);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    minimal.rawPaths = [];
    minimal.coverageLimits = [];
    text = JSON.stringify(minimal);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) fail("summary cannot fit the requested byte limit", "E_SUMMARY_LIMIT");
  return { summary: minimal, text };
}

export async function writeSummary(artifactDir, root, artifactRelative, summary, maxBytes) {
  const full = { ...summary, detailsPath: `${artifactRelative}/details.json` };
  await fsp.writeFile(path.join(artifactDir, "details.json"), `${JSON.stringify(full, null, 2)}\n`, { flag: "wx" });
  const limit = maxBytes ?? DEFAULT_SUMMARY_BYTES;
  const bounded = summaryWithinLimit(full, Math.max(512, limit - 1));
  if (Buffer.byteLength(bounded.text + "\n") > limit) fail("summary plus newline exceeds requested byte limit", "E_SUMMARY_LIMIT");
  await fsp.writeFile(path.join(artifactDir, "summary.json"), `${bounded.text}\n`, { flag: "wx" });
  return bounded.summary;
}

export function extractSessionRefs(result) {
  const fields = ["sessionId", "threadId", "conversationId", "sessionRef", "session_ref"];
  const refs = [];
  for (const field of fields) if (typeof result?.[field] === "string") refs.push({ field, value: result[field] });
  return refs;
}

export function validateResultArtifact(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, reason: "result is not an object" };
  if (typeof value.status !== "string") return { valid: false, reason: "result.status is missing" };
  const status = value.status.toLowerCase();
  if (NONTERMINAL_STATUSES.has(status)) return { valid: false, reason: `result is nonterminal: ${value.status}`, nonterminal: true };
  if (!TERMINAL_STATUSES.has(status)) return { valid: false, reason: `unknown result status: ${value.status}` };
  if (!Number.isInteger(value.exitCode)) return { valid: false, reason: "result.exitCode must be an integer" };
  if (status === "completed" && value.exitCode !== 0) return { valid: false, reason: "completed result has nonzero exitCode" };
  return { valid: true, status };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createCorrectionPolicy(options = {}) {
  const maxCorrections = options.maxCorrections ?? DEFAULT_CORRECTION_ATTEMPTS;
  if (options.source === "executor") fail("correction policy is Phase-configured; executor cannot raise or replace it", "E_POLICY_SOURCE");
  if (!Number.isInteger(maxCorrections) || maxCorrections < 0 || maxCorrections > ABSOLUTE_CORRECTION_CEILING) {
    fail(`maxCorrections must be an integer from 0 through ${ABSOLUTE_CORRECTION_CEILING}`, "E_CORRECTION_CEILING");
  }
  return {
    schemaVersion: "dd.correction-policy.v1",
    defaultCorrections: DEFAULT_CORRECTION_ATTEMPTS,
    maxCorrections,
    absoluteCeiling: ABSOLUTE_CORRECTION_CEILING,
    configuredBy: "phase",
  };
}

export function evaluateCorrection({ policy = createCorrectionPolicy(), attempt = 0, priorDefects = [], currentDefects = [], relevantEvidenceChanged = false, meaningfulDelta = false } = {}) {
  if (!policy || !Number.isInteger(policy.maxCorrections) || policy.maxCorrections < 0 || policy.maxCorrections > ABSOLUTE_CORRECTION_CEILING) {
    fail("correction policy exceeds the absolute ceiling or is malformed", "E_CORRECTION_CEILING");
  }
  if (!Number.isInteger(attempt) || attempt < 0) fail("correction attempt must be a non-negative integer", "E_CORRECTION_ATTEMPT");
  if (currentDefects.length === 0) return { decision: "ACCEPT", reason: "no blocking defects remain", attempt };
  if (attempt >= policy.maxCorrections) {
    return { decision: "STOP", reason: "correction limit reached", stopCode: "STOPPED_CORRECTION_LIMIT", attempt };
  }
  const noProgress = stableJson(priorDefects) === stableJson(currentDefects) && !relevantEvidenceChanged && !meaningfulDelta;
  if (noProgress) {
    return { decision: "STOP", reason: "same blocking defects remain without relevant evidence or meaningful delta", stopCode: "STOPPED_NO_PROGRESS", attempt };
  }
  return { decision: "ALLOW", reason: "new evidence or a meaningful correction delta is present", nextAttempt: attempt + 1 };
}
