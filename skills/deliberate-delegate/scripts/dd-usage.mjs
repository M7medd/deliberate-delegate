#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "dd.usage-ledger.v1";
const ROLES = new Set(["planning-lead", "planner-2", "executor"]);
const METRIC_KEYS = [
  "calls",
  "failedCalls",
  "turns",
  "toolCalls",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "providerCostUsd",
];

function usage() {
  return `Deliberate Delegate usage recorder

Usage:
  node dd-usage.mjs init --root <project> --ledger <relative-path> --experiment-id <id>
  node dd-usage.mjs capture --root <project> --ledger <relative-path> --role <role> --source <path> [--label <text>] [--baseline]
  node dd-usage.mjs report --root <project> --ledger <relative-path>

Roles: planning-lead | planner-2 | executor

The ledger is append-only. Sources are read-only and may be a Codex rollout JSONL,
a delegate run directory, result.json, or events.jsonl. Missing provider metrics
remain unknown; the recorder does not estimate them.`;
}

function fail(message) {
  process.stderr.write(`dd-usage: ${message}\n`);
  process.exit(2);
}

function usageError(message, code = "E_USAGE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!new Set(["init", "capture", "report"]).has(command)) fail(`unknown command: ${command}`);
  const opts = { command, root: ".", ledger: null, experimentId: null, role: null, source: null, label: null, baseline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) fail(`missing value for ${token}`);
      return argv[++index];
    };
    switch (token) {
      case "--root": opts.root = next(); break;
      case "--ledger": opts.ledger = next(); break;
      case "--experiment-id": opts.experimentId = next(); break;
      case "--role": opts.role = next(); break;
      case "--source": opts.source = next(); break;
      case "--label": opts.label = next(); break;
      case "--baseline": opts.baseline = true; break;
      case "--help":
      case "-h": process.stdout.write(`${usage()}\n`); process.exit(0); break;
      default: fail(`unknown option: ${token}`);
    }
  }
  if (!opts.ledger) fail("--ledger is required");
  if (command === "init" && !opts.experimentId) fail("init requires --experiment-id");
  if (command === "capture") {
    if (!ROLES.has(opts.role)) fail("capture requires --role planning-lead, planner-2, or executor");
    if (!opts.source) fail("capture requires --source");
  }
  return opts;
}

function canonicalRoot(value) {
  const absolute = resolve(value);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) fail(`--root is not a directory: ${absolute}`);
  return realpathSync(absolute);
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ledgerPath(root, value) {
  const absolute = resolve(root, value);
  if (!inside(root, absolute)) fail("--ledger must stay inside --root");
  let ancestor = absolute;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) fail("could not resolve ledger parent");
    ancestor = parent;
  }
  const resolvedAncestor = realpathSync(ancestor);
  const resolvedTarget = resolve(resolvedAncestor, relative(ancestor, absolute));
  if (!inside(root, resolvedTarget)) fail("--ledger must stay inside --root after resolving links");
  return absolute;
}

function readJsonLines(path) {
  const records = [];
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* raw non-JSON lines remain outside the ledger */ }
  }
  return records;
}

function readJsonLinesStrict(path) {
  const records = [];
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw usageError(`could not read usage ledger: ${error.message}`, "E_USAGE_READ");
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw usageError(`usage ledger line ${index + 1} is not valid JSON`, "E_USAGE_LEDGER");
    }
  }
  return records;
}

function readLedger(path) {
  if (!existsSync(path)) fail(`ledger does not exist: ${path}`);
  const rows = readJsonLines(path);
  if (!rows.length || rows[0].schema !== SCHEMA || rows[0].type !== "experiment_start") fail("invalid usage ledger");
  return rows;
}

function readLedgerLibrary(path) {
  if (!existsSync(path)) throw usageError(`ledger does not exist: ${path}`, "E_USAGE_LEDGER");
  const rows = readJsonLinesStrict(path);
  if (!rows.length || rows[0]?.schema !== SCHEMA || rows[0]?.type !== "experiment_start") {
    throw usageError("invalid usage ledger", "E_USAGE_LEDGER");
  }
  if (typeof rows[0].experimentId !== "string" || rows[0].experimentId.length === 0) {
    throw usageError("usage ledger experiment ID is missing", "E_USAGE_LEDGER");
  }
  return rows;
}

function appendRecord(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function sha256Files(paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path, "utf8");
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function n(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedString(value, limit = 160) {
  if (typeof value !== "string") return null;
  return value.slice(0, limit);
}

function canonicalPathKey(value) {
  const canonical = realpathSync(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function sourceKey(value) {
  return createHash("sha256").update(canonicalPathKey(value), "utf8").digest("hex");
}

function safeLocator(root, value) {
  if (!value) return null;
  const canonical = realpathSync(value);
  if (inside(root, canonical)) return relative(root, canonical).replaceAll("\\", "/") || ".";
  return `<outside-root:${sourceKey(canonical).slice(0, 16)}>`;
}

function sourcePrefix(source, root) {
  return source.files.map((file) => {
    const bytes = readFileSync(file);
    return {
      locator: safeLocator(root, file),
      fileKey: sourceKey(file),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

export function usageSourcePrefixMatches(source, root, prefix) {
  if (!source || !Array.isArray(source.files) || !Array.isArray(prefix) || prefix.length === 0) {
    return { valid: false, reason: "baseline source-prefix evidence is missing" };
  }
  const currentFiles = new Map(source.files.map((file) => [sourceKey(file), file]));
  for (const entry of prefix) {
    if (!entry || typeof entry.fileKey !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))) {
      return { valid: false, reason: "baseline source-prefix evidence is malformed" };
    }
    const file = currentFiles.get(entry.fileKey);
    if (!file) return { valid: false, reason: "a baseline source file is missing or was replaced" };
    const bytes = readFileSync(file);
    if (bytes.length < entry.bytes) return { valid: false, reason: "the current rollout is shorter than the recorded baseline" };
    const digest = createHash("sha256").update(bytes.subarray(0, entry.bytes)).digest("hex");
    if (digest !== entry.sha256) return { valid: false, reason: "the current rollout is not an append-only extension of the recorded baseline" };
  }
  return { valid: true };
}

function sum(values) {
  const measured = values.filter((value) => n(value) !== null);
  return measured.length ? measured.reduce((total, value) => total + value, 0) : null;
}

function firstMeasured(values) {
  return values.map(n).find((value) => value !== null) ?? null;
}

function normalizedMetrics(value = {}) {
  return {
    calls: n(value.calls),
    failedCalls: n(value.failedCalls),
    turns: n(value.turns),
    toolCalls: n(value.toolCalls),
    inputTokens: n(value.inputTokens ?? value.input_tokens),
    cachedInputTokens: n(value.cachedInputTokens ?? value.cached_input_tokens),
    cacheWriteInputTokens: n(value.cacheWriteInputTokens ?? value.cache_write_input_tokens),
    cacheCreationInputTokens: n(value.cacheCreationInputTokens ?? value.cache_creation_input_tokens),
    cacheReadInputTokens: n(value.cacheReadInputTokens ?? value.cache_read_input_tokens),
    outputTokens: n(value.outputTokens ?? value.output_tokens),
    reasoningOutputTokens: n(value.reasoningOutputTokens ?? value.reasoning_output_tokens),
    totalTokens: n(value.totalTokens ?? value.total_tokens),
    providerCostUsd: n(value.providerCostUsd ?? value.costUSD ?? value.totalCostUsd ?? value.total_cost_usd),
  };
}

function normalizeUtilization(value) {
  if (n(value) === null) return null;
  return value >= 0 && value <= 1 ? value * 100 : value;
}

function claudeRateLimits(event) {
  const info = event?.rate_limit_info;
  if (!info) return null;
  const five = info.unifiedWindows?.five_hour;
  const seven = info.unifiedWindows?.seven_day;
  return {
    source: "claude-rate_limit_event",
    fiveHour: five ? { usedPercent: normalizeUtilization(five.utilization), resetsAt: n(five.resetsAt) } : null,
    sevenDay: seven ? { usedPercent: normalizeUtilization(seven.utilization), resetsAt: n(seven.resetsAt) } : null,
  };
}

function codexRateLimits(value) {
  if (!value) return null;
  const convert = (window) => window ? {
    usedPercent: n(window.used_percent),
    windowMinutes: n(window.window_minutes),
    resetsAt: n(window.resets_at),
  } : null;
  return { source: "codex-token_count", primary: convert(value.primary), secondary: convert(value.secondary) };
}

function toolCallType(value) {
  if (typeof value !== "string") return false;
  return value === "function_call" || value === "custom_tool_call" || value === "local_shell_call" ||
    value === "mcp_tool_call" || value === "web_search_call" || value === "tool_use";
}

function parseCodexRollout(events) {
  let latestUsage = null;
  let rateLimits = null;
  let contextWindow = null;
  let sessionId = null;
  let threadId = null;
  let turns = 0;
  let toolCalls = 0;
  for (const event of events) {
    if (event.type === "session_meta") sessionId = event.payload?.id ?? sessionId;
    if (event.type === "token_usage_record") {
      turns += 1;
      latestUsage = event.payload?.thread_token_usage ?? event.payload?.usage ?? latestUsage;
      threadId = event.payload?.thread_id ?? threadId;
      sessionId = event.payload?.session_id ?? sessionId;
    }
    if (event.type === "event_msg" && event.payload?.type === "token_count") {
      latestUsage = event.payload?.info?.total_token_usage ?? latestUsage;
      contextWindow = n(event.payload?.info?.model_context_window) ?? contextWindow;
      rateLimits = codexRateLimits(event.payload?.rate_limits) ?? rateLimits;
    }
    if (event.type === "response_item" && toolCallType(event.payload?.type)) toolCalls += 1;
  }
  const metrics = normalizedMetrics({ ...latestUsage, turns, toolCalls });
  return { kind: "codex-rollout", metrics, rateLimits, contextWindow, sessionId, threadId, model: null, status: "snapshot" };
}

function parseClaudeRun(events, result) {
  const terminal = [...events].reverse().find((event) => event?.type === "result") ?? null;
  const modelUsage = terminal?.modelUsage && typeof terminal.modelUsage === "object" ? Object.values(terminal.modelUsage) : [];
  let usage;
  let models = [];
  const itemizedCost = modelUsage.length ? sum(modelUsage.map((item) => item?.costUSD)) : null;
  const fallbackCost = firstMeasured([result?.totalCostUsd, terminal?.total_cost_usd]);
  if (modelUsage.length) {
    models = Object.keys(terminal.modelUsage);
    usage = {
      inputTokens: sum(modelUsage.map((item) => item.inputTokens)),
      cacheCreationInputTokens: sum(modelUsage.map((item) => item.cacheCreationInputTokens)),
      cacheReadInputTokens: sum(modelUsage.map((item) => item.cacheReadInputTokens)),
      outputTokens: sum(modelUsage.map((item) => item.outputTokens)),
      reasoningOutputTokens: sum(modelUsage.map((item) => item.thinkingTokens)),
      providerCostUsd: itemizedCost ?? fallbackCost,
    };
  } else {
    usage = { ...(terminal?.usage ?? result?.usage ?? {}) };
    if (usage.providerCostUsd === undefined && usage.costUSD === undefined && usage.totalCostUsd === undefined && usage.total_cost_usd === undefined) {
      usage.totalCostUsd = fallbackCost;
    }
  }
  const toolCalls = events.reduce((count, event) => count + (event?.type === "assistant" && Array.isArray(event.message?.content)
    ? event.message.content.filter((item) => item?.type === "tool_use").length : 0), 0);
  const terminalError = terminal?.is_error === true || Boolean(terminal?.api_error_status) || (terminal !== null && terminal.subtype !== undefined && terminal.subtype !== "success");
  const failed = result?.status ? result.status !== "completed" || terminalError : terminalError;
  const input = n(usage.inputTokens ?? usage.input_tokens);
  const cacheCreation = n(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens);
  const cacheRead = n(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens);
  const output = n(usage.outputTokens ?? usage.output_tokens);
  const metrics = normalizedMetrics({
    ...usage,
    calls: 1,
    failedCalls: failed ? 1 : 0,
    turns: n(terminal?.num_turns),
    toolCalls,
    totalTokens: sum([input, cacheCreation, cacheRead, output]),
  });
  const rateEvent = [...events].reverse().find((event) => event?.type === "rate_limit_event");
  return {
    kind: "claude-run",
    metrics,
    rateLimits: claudeRateLimits(rateEvent),
    contextWindow: modelUsage.length ? Math.max(...modelUsage.map((item) => n(item.contextWindow) ?? 0)) || null : null,
    sessionId: terminal?.session_id ?? result?.sessionId ?? null,
    threadId: null,
    model: models.length ? models.join(",") : result?.model ?? events.find((event) => event?.type === "system" && event?.subtype === "init" && typeof event.model === "string")?.model ?? null,
    status: result?.status ?? (failed ? "failed" : "completed"),
  };
}

function extractUsageCandidate(event) {
  const candidates = [event?.usage, event?.payload?.usage, event?.payload?.info?.total_token_usage];
  return candidates.find((value) => value && typeof value === "object") ?? null;
}

function parseDelegateRun(events, result) {
  let usage = null;
  let turns = 0;
  let toolCalls = 0;
  for (const event of events) {
    usage = extractUsageCandidate(event) ?? usage;
    const type = event?.type ?? event?.payload?.type;
    if (type === "turn.completed" || type === "turn_completed") turns += 1;
    const itemType = event?.item?.type ?? event?.payload?.item?.type ?? event?.payload?.type;
    if ((type === "item.completed" || type === "item_completed") &&
      (toolCallType(itemType) || itemType === "command_execution" || itemType === "mcp_tool_call")) toolCalls += 1;
  }
  const failed = result?.status ? result.status !== "completed" : false;
  return {
    kind: "delegate-run",
    metrics: normalizedMetrics({ ...usage, calls: 1, failedCalls: failed ? 1 : 0, turns, toolCalls }),
    rateLimits: null,
    contextWindow: null,
    sessionId: result?.sessionId ?? result?.threadId ?? result?.session ?? null,
    threadId: result?.threadId ?? null,
    model: result?.model ?? null,
    status: result?.status ?? "unknown",
  };
}

function resolveSourceInternal(value, onError) {
  const requested = resolve(value);
  if (!existsSync(requested)) onError(`source does not exist: ${requested}`, "E_USAGE_SOURCE");
  const absolute = realpathSync(requested);
  const sourceStat = statSync(absolute);
  let eventsPath = null;
  let resultPath = null;
  if (sourceStat.isDirectory()) {
    const events = join(absolute, "events.jsonl");
    const result = join(absolute, "result.json");
    if (existsSync(events)) eventsPath = events;
    if (existsSync(result)) resultPath = result;
  } else if (absolute.toLowerCase().endsWith("result.json")) {
    resultPath = absolute;
    const events = join(dirname(absolute), "events.jsonl");
    if (existsSync(events)) eventsPath = events;
  } else {
    eventsPath = absolute;
    const result = join(dirname(absolute), "result.json");
    if (existsSync(result)) resultPath = result;
  }
  if (!eventsPath) onError("source has no events.jsonl or JSONL event file", "E_USAGE_SOURCE");
  const files = [eventsPath, ...(resultPath ? [resultPath] : [])];
  return { requestedPath: absolute, sourceKey: sourceKey(absolute), eventsPath, resultPath, files };
}

function resolveSource(value) {
  return resolveSourceInternal(value, (message) => fail(message));
}

export function resolveUsageSource(value) {
  return resolveSourceInternal(value, (message, code) => { throw usageError(message, code); });
}

function parseSource(source) {
  const events = readJsonLines(source.eventsPath);
  const result = source.resultPath ? JSON.parse(readFileSync(source.resultPath, "utf8")) : null;
  if (events.some((event) => event?.type === "session_meta" || event?.type === "token_usage_record")) return parseCodexRollout(events);
  if (events.some((event) => event?.type === "result" || event?.type === "rate_limit_event" || event?.modelUsage)) return parseClaudeRun(events, result);
  return parseDelegateRun(events, result);
}

function metricDelta(current, previous, baseline) {
  const delta = {};
  for (const key of METRIC_KEYS) {
    const value = n(current[key]);
    if (baseline) delta[key] = value === null ? null : 0;
    else if (!previous || n(previous[key]) === null || value === null) delta[key] = value;
    else delta[key] = value >= previous[key] ? value - previous[key] : null;
  }
  return delta;
}

function coverage(metrics, rateLimits) {
  return {
    tokens: [metrics.inputTokens, metrics.outputTokens].some((value) => n(value) !== null) ? "measured" : "unknown",
    cache: [metrics.cachedInputTokens, metrics.cacheCreationInputTokens, metrics.cacheReadInputTokens].some((value) => n(value) !== null) ? "measured" : "unknown",
    cost: n(metrics.providerCostUsd) !== null ? "measured" : "unknown",
    turns: n(metrics.turns) !== null ? "measured" : "unknown",
    toolCalls: n(metrics.toolCalls) !== null ? "measured" : "unknown",
    rateLimits: rateLimits ? "measured" : "unknown",
  };
}

function init(opts, root, ledger) {
  if (existsSync(ledger)) fail(`refusing to overwrite existing ledger: ${ledger}`);
  mkdirSync(dirname(ledger), { recursive: true });
  const record = { schema: SCHEMA, type: "experiment_start", experimentId: opts.experimentId, createdAt: new Date().toISOString(), root };
  writeFileSync(ledger, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`usage ledger initialized: ${ledger}\n`);
}

export function ensureUsageLedger({ ledgerPath, experimentId, root, createdAt = new Date().toISOString() } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) throw usageError("ledgerPath is required", "E_USAGE_ARGS");
  if (typeof experimentId !== "string" || experimentId.length === 0) throw usageError("experimentId is required", "E_USAGE_ARGS");
  if (typeof root !== "string" || root.length === 0) throw usageError("root is required", "E_USAGE_ARGS");
  const makeRecord = () => ({ schema: SCHEMA, type: "experiment_start", experimentId, createdAt, root });
  if (existsSync(ledgerPath)) {
    const rows = readLedgerLibrary(ledgerPath);
    if (rows[0].experimentId !== experimentId) {
      throw usageError(`ledger experiment ID conflicts with requested experiment: ${rows[0].experimentId}`, "E_EXPERIMENT_CONFLICT");
    }
    if (rows[0].root && rows[0].root !== root) {
      throw usageError("ledger project root conflicts with requested project root", "E_EXPERIMENT_CONFLICT");
    }
    return { initialized: false, record: rows[0], rows };
  }
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const record = makeRecord();
  try {
    writeFileSync(ledgerPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const rows = readLedgerLibrary(ledgerPath);
    if (rows[0].experimentId !== experimentId || (rows[0].root && rows[0].root !== root)) {
      throw usageError("ledger was initialized by a conflicting experiment", "E_EXPERIMENT_CONFLICT");
    }
    return { initialized: false, record: rows[0], rows };
  }
  return { initialized: true, record, rows: [record] };
}

export function readUsageLedger(ledgerPath) {
  return readLedgerLibrary(ledgerPath);
}

export function usageSourceDigest(source) {
  if (!source || !Array.isArray(source.files) || source.files.length === 0) {
    throw usageError("usage source files are required", "E_USAGE_SOURCE");
  }
  return sha256Files(source.files);
}

export function captureUsage({
  ledgerPath,
  root,
  role,
  source: sourceValue,
  label = null,
  baseline = false,
  idempotencyNamespace = null,
  captureKind = null,
} = {}) {
  if (!ROLES.has(role)) throw usageError(`unsupported usage role: ${role}`, "E_USAGE_ARGS");
  if (typeof sourceValue !== "string" || sourceValue.length === 0) throw usageError("source is required", "E_USAGE_ARGS");
  const rows = readLedgerLibrary(ledgerPath);
  const source = resolveUsageSource(sourceValue);
  const digest = usageSourceDigest(source);
  const namespace = idempotencyNamespace === null ? "" : `\0${String(idempotencyNamespace)}`;
  const idempotencyKey = createHash("sha256").update(`${role}\0${source.sourceKey}\0${digest}${namespace}`).digest("hex");
  const duplicate = rows.find((row) => row.type === "usage_capture" && row.idempotencyKey === idempotencyKey);
  if (duplicate) return { duplicate: true, captureId: duplicate.captureId, record: duplicate, source };
  const parsed = parseSource(source);
  const previous = [...rows].reverse().find((row) => row.type === "usage_capture" && row.role === role &&
    row.source?.sourceKey === source.sourceKey && row.source?.kind === parsed.kind);
  if (parsed.kind === "codex-rollout" && !baseline && !previous) {
    throw usageError("first capture of a Codex rollout requires --baseline", "E_USAGE_BASELINE");
  }
  const captureId = `usage-${String(rows.filter((row) => row.type === "usage_capture").length + 1).padStart(4, "0")}`;
  const record = {
    schema: SCHEMA,
    type: "usage_capture",
    experimentId: rows[0].experimentId,
    captureId,
    capturedAt: new Date().toISOString(),
    role,
    label: boundedString(label),
    baseline: Boolean(baseline),
    status: boundedString(parsed.status, 80),
    sessionId: boundedString(parsed.sessionId),
    threadId: boundedString(parsed.threadId),
    model: boundedString(parsed.model),
    source: {
      locator: safeLocator(root, source.requestedPath),
      sourceKey: source.sourceKey,
      kind: parsed.kind,
      eventsLocator: safeLocator(root, source.eventsPath),
      resultLocator: safeLocator(root, source.resultPath),
      sha256: digest,
    },
    metrics: parsed.metrics,
    delta: metricDelta(parsed.metrics, previous?.metrics, Boolean(baseline)),
    contextWindowTokens: parsed.contextWindow,
    rateLimits: parsed.rateLimits,
    coverage: coverage(parsed.metrics, parsed.rateLimits),
    idempotencyKey,
  };
  if (baseline) record.source.prefix = sourcePrefix(source, root);
  if (captureKind !== null) record.captureKind = boundedString(captureKind, 80);
  appendRecord(ledgerPath, record);
  return { duplicate: false, captureId, record, source };
}

function capture(opts, root, ledger) {
  let result;
  try {
    result = captureUsage({
      ledgerPath: ledger,
      root,
      role: opts.role,
      source: opts.source,
      label: opts.label,
      baseline: opts.baseline,
    });
  } catch (error) {
    fail(error.message);
  }
  if (result.duplicate) {
    process.stdout.write(`usage capture already recorded: ${result.captureId}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ captureId: result.captureId, role: opts.role, kind: result.record.source.kind, delta: result.record.delta, rateLimits: result.record.rateLimits, coverage: result.record.coverage }, null, 2)}\n`);
}

function formatNumber(value) {
  return n(value) === null ? "unknown" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

function aggregateCoverage(rows, key) {
  const values = rows.map((row) => row.coverage?.[key] ?? "unknown");
  const measured = values.filter((value) => value === "measured").length;
  if (measured === values.length) return "complete_for_captured";
  if (measured === 0) return "unknown";
  return "partial";
}

function report(_opts, _root, ledger) {
  const rows = readLedger(ledger);
  const captures = rows.filter((row) => row.type === "usage_capture");
  process.stdout.write(`Experiment: ${rows[0].experimentId}\n`);
  for (const role of ROLES) {
    const roleRows = captures.filter((row) => row.role === role);
    if (!roleRows.length) {
      process.stdout.write(`\n${role}: no captures\n`);
      continue;
    }
    const totals = {};
    for (const key of METRIC_KEYS) totals[key] = sum(roleRows.map((row) => row.delta?.[key]));
    const latest = roleRows.at(-1);
    const aggregate = {
      tokens: aggregateCoverage(roleRows, "tokens"),
      cache: aggregateCoverage(roleRows, "cache"),
      cost: aggregateCoverage(roleRows, "cost"),
      turns: aggregateCoverage(roleRows, "turns"),
      toolCalls: aggregateCoverage(roleRows, "toolCalls"),
      rateLimits: aggregateCoverage(roleRows, "rateLimits"),
    };
    process.stdout.write(`\n${role}:\n`);
    process.stdout.write(`  captures: ${roleRows.length}\n`);
    process.stdout.write(`  calls: ${formatNumber(totals.calls)} (failed: ${formatNumber(totals.failedCalls)})\n`);
    process.stdout.write(`  turns: ${formatNumber(totals.turns)}; tools: ${formatNumber(totals.toolCalls)}\n`);
    process.stdout.write(`  input: ${formatNumber(totals.inputTokens)}; cached: ${formatNumber(totals.cachedInputTokens)}\n`);
    process.stdout.write(`  cache creation: ${formatNumber(totals.cacheCreationInputTokens)}; cache read: ${formatNumber(totals.cacheReadInputTokens)}\n`);
    process.stdout.write(`  output: ${formatNumber(totals.outputTokens)}; reasoning: ${formatNumber(totals.reasoningOutputTokens)}\n`);
    process.stdout.write(`  provider-reported list-price metadata USD (not subscription charge): ${formatNumber(totals.providerCostUsd)}\n`);
    process.stdout.write(`  latest rate limits: ${latest.rateLimits ? JSON.stringify(latest.rateLimits) : "unknown"}\n`);
    process.stdout.write(`  coverage across captures: ${JSON.stringify(aggregate)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const opts = parseArgs(process.argv.slice(2));
  const root = canonicalRoot(opts.root);
  const ledger = ledgerPath(root, opts.ledger);
  if (opts.command === "init") init(opts, root, ledger);
  else if (opts.command === "capture") capture(opts, root, ledger);
  else report(opts, root, ledger);
}

export { SCHEMA as USAGE_LEDGER_SCHEMA, ROLES as USAGE_ROLES };
