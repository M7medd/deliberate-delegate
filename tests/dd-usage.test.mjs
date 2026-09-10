import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "skills", "deliberate-delegate", "scripts", "dd-usage.mjs");
const scratch = path.join(repo, "tests", ".dd-usage-scratch");

async function fixture() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(path.join(scratch, "fixture-"));
}

function run(root, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

async function rows(pathname) {
  return (await readFile(pathname, "utf8")).trim().split(/\r?\n/).map((value) => JSON.parse(value));
}

test("Codex rollout baseline and later capture record only experiment delta", async () => {
  const root = await fixture();
  try {
    const ledger = "docs/deliberate-delegate/experiment-usage.jsonl";
    const ledgerPath = path.join(root, ...ledger.split("/"));
    const rollout = path.join(root, "lead.jsonl");
    await writeFile(rollout,
      line({ type: "session_meta", payload: { id: "lead-session" } }) +
      line({ type: "token_usage_record", payload: { thread_id: "lead-thread", session_id: "lead-session", thread_token_usage: {
        input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110,
      } } }) +
      line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110,
      }, model_context_window: 258400 }, rate_limits: {
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1000 },
        secondary: { used_percent: 30, window_minutes: 10080, resets_at: 2000 },
      } } }), "utf8");

    let result = run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-1"]);
    assert.equal(result.status, 0, result.stderr);
    result = run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "planning-lead", "--source", rollout, "--baseline"]);
    assert.equal(result.status, 0, result.stderr);

    await appendFile(rollout,
      line({ type: "response_item", payload: { type: "function_call" } }) +
      line({ type: "token_usage_record", payload: { thread_id: "lead-thread", session_id: "lead-session", thread_token_usage: {
        input_tokens: 160, cached_input_tokens: 70, output_tokens: 16, reasoning_output_tokens: 7, total_tokens: 176,
      } } }) +
      line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
        input_tokens: 160, cached_input_tokens: 70, output_tokens: 16, reasoning_output_tokens: 7, total_tokens: 176,
      }, model_context_window: 258400 }, rate_limits: {
        primary: { used_percent: 18, window_minutes: 300, resets_at: 1000 },
        secondary: { used_percent: 31, window_minutes: 10080, resets_at: 2000 },
      } } }), "utf8");

    result = run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "planning-lead", "--source", rollout, "--label", "wp-01"]);
    assert.equal(result.status, 0, result.stderr);
    const captured = await rows(ledgerPath);
    assert.equal(captured.length, 3);
    assert.equal(captured[1].baseline, true);
    assert.equal(captured[1].delta.inputTokens, 0);
    assert.equal(captured[2].delta.inputTokens, 60);
    assert.equal(captured[2].delta.cachedInputTokens, 30);
    assert.equal(captured[2].delta.turns, 1);
    assert.equal(captured[2].delta.toolCalls, 1);
    assert.equal(captured[2].rateLimits.primary.usedPercent, 18);

    result = run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "planning-lead", "--source", rollout, "--label", "duplicate"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already recorded/);
    assert.equal((await rows(ledgerPath)).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init refuses overwrite and preserves ledger bytes", async () => {
  const root = await fixture();
  try {
    const ledger = "usage.jsonl";
    assert.equal(run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-init"]).status, 0);
    const before = await readFile(path.join(root, ledger));
    const result = run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-replacement"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing to overwrite/);
    assert.deepEqual(await readFile(path.join(root, ledger)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first cumulative Codex capture requires an explicit baseline", async () => {
  const root = await fixture();
  try {
    const ledger = "usage.jsonl";
    const rollout = path.join(root, "lead.jsonl");
    await writeFile(rollout, line({ type: "session_meta", payload: { id: "lead-session" } }) +
      line({ type: "token_usage_record", payload: { thread_token_usage: { input_tokens: 100, output_tokens: 10 } } }));
    assert.equal(run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-baseline"]).status, 0);
    const result = run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "planning-lead", "--source", rollout]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires --baseline/);
    assert.equal((await rows(path.join(root, ledger))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude capture prefers modelUsage, records rate limits, and counts failures", async () => {
  const root = await fixture();
  try {
    const ledger = "usage.jsonl";
    assert.equal(run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-2"]).status, 0);
    const runDir = path.join(root, "claude-run");
    await mkdir(runDir);
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({ status: "failed", model: "opus", sessionId: "claude-session" }));
    await writeFile(path.join(runDir, "events.jsonl"),
      line({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
        five_hour: { utilization: 0.66, resetsAt: 3000 }, seven_day: { utilization: 0.42, resetsAt: 4000 },
      } } }) +
      line({ type: "assistant", message: { content: [{ type: "tool_use" }, { type: "text" }] } }) +
      line({ type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "claude-session", num_turns: 3,
        usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {
          opus: { inputTokens: 2, cacheCreationInputTokens: 100, cacheReadInputTokens: 200, outputTokens: 10, thinkingTokens: 4, costUSD: 1.5, contextWindow: 1000000 },
          haiku: { inputTokens: 3, cacheCreationInputTokens: 5, cacheReadInputTokens: 7, outputTokens: 2, thinkingTokens: 0, costUSD: 0.1, contextWindow: 200000 },
        } }), "utf8");

    const result = run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "planner-2", "--source", runDir, "--label", "review-1"]);
    assert.equal(result.status, 0, result.stderr);
    const captured = (await rows(path.join(root, ledger)))[1];
    assert.equal(captured.metrics.inputTokens, 5);
    assert.equal(captured.metrics.cacheCreationInputTokens, 105);
    assert.equal(captured.metrics.cacheReadInputTokens, 207);
    assert.equal(captured.metrics.outputTokens, 12);
    assert.equal(captured.metrics.failedCalls, 1);
    assert.equal(captured.metrics.toolCalls, 1);
    assert.equal(captured.metrics.providerCostUsd, 1.6);
    assert.equal(captured.rateLimits.fiveHour.usedPercent, 66);
    assert.equal(captured.rateLimits.sevenDay.usedPercent, 42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger never copies prompts, assistant text, or credential-shaped literals", async () => {
  const root = await fixture();
  try {
    const ledger = "usage.jsonl";
    const runDir = path.join(root, "claude-sensitive-run");
    const assistantText = "UNIQUE_ASSISTANT_PRIVATE_TEXT_52f0";
    const userPrompt = "UNIQUE_USER_PROMPT_PRIVATE_TEXT_734a";
    const fakeCredential = "sk-test-DO-NOT-COPY-123456789";
    await mkdir(runDir);
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({ status: "completed", model: "opus", sessionId: "safe-session" }));
    await writeFile(path.join(runDir, "events.jsonl"),
      line({ type: "user", message: { content: userPrompt } }) +
      line({ type: "assistant", message: { content: [{ type: "text", text: assistantText }] } }) +
      line({ type: "diagnostic", value: fakeCredential }) +
      line({ type: "result", subtype: "success", session_id: "safe-session", num_turns: 1,
        modelUsage: { opus: { inputTokens: 2, outputTokens: 3, costUSD: 0.01 } } }));
    assert.equal(run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-redaction"]).status, 0);
    assert.equal(run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "planner-2", "--source", runDir]).status, 0);
    const rawLedger = await readFile(path.join(root, ledger), "utf8");
    for (const sensitive of [assistantText, userPrompt, fakeCredential]) assert.equal(rawLedger.includes(sensitive), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report is compact and unknown stays explicit", async () => {
  const root = await fixture();
  try {
    const ledger = "usage.jsonl";
    assert.equal(run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-3"]).status, 0);
    const runDir = path.join(root, "executor-run");
    await mkdir(runDir);
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({ status: "completed", threadId: "executor-thread", model: "luna" }));
    await writeFile(path.join(runDir, "events.jsonl"), line({ type: "thread.started", thread_id: "executor-thread" }), "utf8");
    assert.equal(run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "executor", "--source", runDir]).status, 0);
    const result = run(root, ["report", "--root", root, "--ledger", ledger]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /planning-lead: no captures/);
    assert.match(result.stdout, /executor:/);
    assert.match(result.stdout, /input: unknown/);
    assert.match(result.stdout, /latest rate limits: unknown/);
    assert.match(result.stdout, /provider-reported list-price metadata USD \(not subscription charge\): unknown/);
    assert.match(result.stdout, /coverage across captures: \{"tokens":"unknown","cache":"unknown","cost":"unknown","turns":"complete_for_captured","toolCalls":"complete_for_captured","rateLimits":"unknown"\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex delegate run uses turn usage and counts each completed tool once", async () => {
  const root = await fixture();
  try {
    const ledger = "usage.jsonl";
    assert.equal(run(root, ["init", "--root", root, "--ledger", ledger, "--experiment-id", "exp-codex-run"]).status, 0);
    const runDir = path.join(root, "codex-run");
    await mkdir(runDir);
    await writeFile(path.join(runDir, "result.json"), JSON.stringify({ status: "completed", threadId: "executor-thread", model: "gpt-luna" }));
    await writeFile(path.join(runDir, "events.jsonl"),
      line({ type: "thread.started", thread_id: "executor-thread" }) +
      line({ type: "item.started", item: { type: "command_execution" } }) +
      line({ type: "item.completed", item: { type: "command_execution" } }) +
      line({ type: "turn.completed", usage: { input_tokens: 200, cached_input_tokens: 150, output_tokens: 20 } }), "utf8");
    const result = run(root, ["capture", "--root", root, "--ledger", ledger, "--role", "executor", "--source", runDir]);
    assert.equal(result.status, 0, result.stderr);
    const captured = (await rows(path.join(root, ledger)))[1];
    assert.equal(captured.metrics.inputTokens, 200);
    assert.equal(captured.metrics.cachedInputTokens, 150);
    assert.equal(captured.metrics.outputTokens, 20);
    assert.equal(captured.metrics.turns, 1);
    assert.equal(captured.metrics.toolCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger writes are contained within the project root", async () => {
  const root = await fixture();
  try {
    const outside = path.join(tmpdir(), `dd-usage-outside-${Date.now()}.jsonl`);
    const result = run(root, ["init", "--root", root, "--ledger", outside, "--experiment-id", "exp-4"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must stay inside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
