import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repo, "skills", "deliberate-delegate", "scripts", "dd-bootstrap.mjs");
const scratch = path.join(repo, "tests", ".dd-bootstrap-scratch");

async function fixture() {
  await fs.mkdir(scratch, { recursive: true });
  return fs.mkdtemp(path.join(scratch, "fixture-"));
}

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.replaceAll("\\", "/").split("/"));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function adapterProgram({ sessionId = "provider-session-1", ambiguous = false, role = null, badRelay = false } = {}) {
  const result = { status: "completed", exitCode: 0, sessionId };
  if (ambiguous) result.threadId = "second-provider-session";
  if (role) result.role = role;
  const relayEvents = line({ type: "user", text: "UNIQUE_RELAY_PROMPT_BOOTSTRAP" }) +
    line({ type: "diagnostic", value: "sk-relay-DO-NOT-COPY-123456789" }) +
    line({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 4 } });
  const relayResult = badRelay
    ? "{not valid json\n"
    : JSON.stringify({ status: "completed", sessionId: "provider-session-1", model: "caller-declared" });
  return [
    "const fs=require('node:fs');",
    "fs.appendFileSync('dispatch-count','1');",
    "fs.mkdirSync('planner2-relay',{recursive:true});",
    `fs.writeFileSync('planner2-relay/events.jsonl',${JSON.stringify(relayEvents)});`,
    `fs.writeFileSync('planner2-relay/result.json',${JSON.stringify(relayResult)});`,
    `fs.writeFileSync('provider-result.json',${JSON.stringify(JSON.stringify(result))});`,
  ].join("");
}

function argsFile(program) {
  return JSON.stringify(["-e", program]);
}

async function createInputs(root, { program = null, badRelay = false, context = true } = {}) {
  await write(root, "lead-rollout.jsonl",
    line({ type: "session_meta", payload: { id: "lead-session" } }) +
    line({ type: "user", message: { content: "UNIQUE_USER_PROMPT_BOOTSTRAP" } }) +
    line({ type: "assistant", message: { content: [{ type: "text", text: "UNIQUE_ASSISTANT_TEXT_BOOTSTRAP" }] } }) +
    line({ type: "diagnostic", value: "sk-test-DO-NOT-COPY-987654321" }) +
    line({ type: "token_usage_record", payload: { thread_id: "lead-thread", session_id: "lead-session", thread_token_usage: {
      input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110,
    } } }) +
    line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, total_tokens: 110,
    } } } }));
  await write(root, "argv.json", argsFile(program ?? adapterProgram({ badRelay })));
  if (context) {
    await write(root, "context.json", JSON.stringify({
      provider: "claude",
      role: "planner2",
      requiredMode: "automatic",
      requestedSetting: "--autocompact 400k",
      capability: "adapter_flag",
      effectiveSettingEvidence: "caller-declared launch envelope",
      preflightStatus: "verified",
      thresholdPolicy: { targetWindowTokens: 1000000, targetCompactionTokens: 400000 },
    }));
  }
}

function command(root, overrides = {}) {
  const values = {
    root,
    ledger: "usage.jsonl",
    experimentId: "exp-bootstrap",
    leadRollout: path.join(root, "lead-rollout.jsonl"),
    adapter: process.execPath,
    argsFile: "argv.json",
    result: "provider-result.json",
    artifactDir: "controller-artifacts",
    planner2Source: "planner2-relay",
    confirmation: "confirmation.json",
    timeoutMs: "5000",
    suspensionAvailable: "true",
    contextEvidenceFile: "context.json",
    ...overrides,
  };
  const args = [cli];
  const flags = [
    ["root", values.root],
    ["ledger", values.ledger],
    ["experiment-id", values.experimentId],
    ["lead-rollout", values.leadRollout],
    ["adapter", values.adapter],
    ["args-file", values.argsFile],
    ["result", values.result],
    ["artifact-dir", values.artifactDir],
    ["planner2-source", values.planner2Source],
    ["confirmation", values.confirmation],
    ["timeout-ms", values.timeoutMs],
    ["suspension-available", values.suspensionAvailable],
  ];
  if (values.contextEvidenceFile) flags.push(["context-evidence-file", values.contextEvidenceFile]);
  if (values.hostTelemetryFile) flags.push(["host-telemetry-file", values.hostTelemetryFile]);
  for (const [name, value] of flags) args.push(`--${name}`, String(value));
  return args;
}

function run(root, overrides = {}) {
  const result = spawnSync(process.execPath, command(root, overrides), { cwd: root, encoding: "utf8", windowsHide: true });
  let json = null;
  if (result.stdout.trim()) json = JSON.parse(result.stdout.trim());
  return { ...result, json };
}

async function readJson(root, relative) {
  return JSON.parse(await fs.readFile(path.join(root, ...relative.split("/")), "utf8"));
}

async function readLedger(root) {
  const content = await fs.readFile(path.join(root, "usage.jsonl"), "utf8");
  return content.trim().split(/\r?\n/).map((value) => JSON.parse(value));
}

async function appendLeadGrowth(root) {
  await fs.appendFile(path.join(root, "lead-rollout.jsonl"),
    line({ type: "token_usage_record", payload: { thread_id: "lead-thread", session_id: "lead-session", thread_token_usage: {
      input_tokens: 140, cached_input_tokens: 60, output_tokens: 14, total_tokens: 154,
    } } }) +
    line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: 140, cached_input_tokens: 60, output_tokens: 14, total_tokens: 154,
    } } } }), "utf8");
}

async function withFixture(fn, options) {
  const root = await fixture();
  try {
    await createInputs(root, options);
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("bootstrap happy path records one provider attempt, exact session, usage, capsule, boundary, and approval stop", async () => {
  await withFixture(async (root) => {
    await assert.rejects(fs.stat(path.join(root, "planner2-relay")));
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.json.status, "READY_FOR_VERIFICATION");
    assert.equal(first.json.sessionId, "provider-session-1");
    assert.equal(first.json.dispatchCount, 1);
    assert.equal(first.json.suspensionStatus, "unknown");
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");

    const rows = await readLedger(root);
    assert.equal(rows.length, 4);
    assert.equal(rows[1].type, "usage_capture");
    assert.equal(rows[1].role, "planning-lead");
    assert.equal(rows[1].baseline, true);
    assert.deepEqual(rows[1].delta.inputTokens, 0);
    assert.equal(rows[2].role, "planner-2");
    assert.equal(rows[3].role, "planning-lead");
    assert.equal(rows[3].captureKind, "planning-lead-confirmation-boundary");

    const capsule = await readJson(root, "controller-artifacts/capsule.v1.json");
    assert.equal(capsule.role, "planner");
    assert.equal(capsule.roleStatus, "NEEDS_EVIDENCE");
    assert.deepEqual(capsule.observedSessionIds, ["provider-session-1"]);
    assert.equal((await readJson(root, "confirmation.json")).session.id, "provider-session-1");
    const confirmation = await readJson(root, "confirmation.json");
    assert.match(confirmation.leadBoundary.limitation, /not a complete post-human-seeing turn/);
    assert.equal(confirmation.contextManagement.requestedSetting, "--autocompact 400k");
    assert.equal(confirmation.contextManagement.authoritative, false);
    assert.equal(confirmation.contextManagement.providerEnforcementClaim, "not_claimed");
    const compact = `${await fs.readFile(path.join(root, "usage.jsonl"), "utf8")}\n${JSON.stringify(confirmation)}`;
    for (const sensitive of [
      "UNIQUE_USER_PROMPT_BOOTSTRAP",
      "UNIQUE_ASSISTANT_TEXT_BOOTSTRAP",
      "UNIQUE_RELAY_PROMPT_BOOTSTRAP",
      "sk-test-DO-NOT-COPY-987654321",
      "sk-relay-DO-NOT-COPY-123456789",
    ]) assert.equal(compact.includes(sensitive), false, sensitive);
  });
});

test("identical completed bootstrap reuses the capsule and does not duplicate child or usage records", async () => {
  await withFixture(async (root) => {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    const before = await readLedger(root);
    const second = run(root);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.status, "READY_FOR_VERIFICATION");
    assert.equal(second.json.controllerStatus, "REUSED");
    assert.equal(second.json.dispatchCount, 0);
    assert.equal(second.json.reused, true);
    assert.equal(second.json.confirmationReused, true);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
    assert.deepEqual(await readLedger(root), before);
  });
});

test("provider success followed by relay failure preserves evidence and restart never relaunches", async () => {
  await withFixture(async (root) => {
    await assert.rejects(fs.stat(path.join(root, "planner2-relay")));
    const failed = run(root);
    assert.equal(failed.status, 1);
    assert.equal(failed.json.status, "BLOCKED");
    assert.equal(failed.json.reason.includes("Planner 2 usage capture failed"), true);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
    await fs.stat(path.join(root, "provider-result.json"));
    await fs.stat(path.join(root, "controller-artifacts", "job.v1.json"));
    await fs.stat(path.join(root, "controller-artifacts", "capsule.v1.json"));

    await fs.writeFile(path.join(root, "planner2-relay", "result.json"), JSON.stringify({ status: "completed", sessionId: "provider-session-1" }), "utf8");
    const resumed = run(root);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.json.controllerStatus, "REUSED");
    assert.equal(resumed.json.dispatchCount, 0);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
    assert.equal((await readLedger(root)).length, 4);
  }, { badRelay: true });
});

test("growing Lead rollout reuses the immutable baseline and records only the new boundary", async () => {
  await withFixture(async (root) => {
    const failed = run(root);
    assert.equal(failed.status, 1);
    const beforeRestart = await readLedger(root);
    const baselineDigest = beforeRestart[1].source.sha256;
    assert.equal(Array.isArray(beforeRestart[1].source.prefix), true);

    await appendLeadGrowth(root);
    await fs.writeFile(path.join(root, "planner2-relay", "result.json"), JSON.stringify({ status: "completed", sessionId: "provider-session-1" }), "utf8");
    const resumed = run(root);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.json.controllerStatus, "REUSED");
    assert.equal(resumed.json.dispatchCount, 0);
    const afterRestart = await readLedger(root);
    assert.equal(afterRestart.filter((row) => row.role === "planning-lead" && row.baseline === true).length, 1);
    assert.equal(afterRestart[1].source.sha256, baselineDigest);
    assert.notEqual(afterRestart[3].source.sha256, baselineDigest);
    assert.equal(afterRestart[3].delta.inputTokens, 40);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  }, { badRelay: true });
});

test("completed bootstrap reuses confirmation without new rows when the Lead rollout grows", async () => {
  await withFixture(async (root) => {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    const beforeRows = await readLedger(root);
    const beforeConfirmation = await fs.readFile(path.join(root, "confirmation.json"), "utf8");
    await appendLeadGrowth(root);

    const second = run(root);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.json.controllerStatus, "REUSED");
    assert.equal(second.json.dispatchCount, 0);
    assert.equal(second.json.confirmationReused, true);
    assert.deepEqual(await readLedger(root), beforeRows);
    assert.equal(await fs.readFile(path.join(root, "confirmation.json"), "utf8"), beforeConfirmation);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });
});

test("invalid argv, unsafe paths, and conflicting experiment fail before provider work", async () => {
  await withFixture(async (root) => {
    await fs.rm(path.join(root, "argv.json"));
    const missing = run(root);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /adapter argv path|does not exist/);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
    await assert.rejects(fs.stat(path.join(root, "usage.jsonl")));
  });

  await withFixture(async (root) => {
    const unsafe = run(root, { ledger: "../outside-ledger.jsonl" });
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /traversal|absolute|ledger/);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
  });

  await withFixture(async (root) => {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    const conflict = run(root, { experimentId: "exp-other" });
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /conflict/);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });
});

test("ambiguous session evidence and a non-planner capsule fail closed without downstream usage", async () => {
  await withFixture(async (root) => {
    await fs.writeFile(path.join(root, "argv.json"), argsFile(adapterProgram({ ambiguous: true })), "utf8");
    const ambiguous = run(root);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /exactly one normalized provider session/);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
    assert.equal((await readLedger(root)).length, 2);
  });

  await withFixture(async (root) => {
    const first = run(root);
    assert.equal(first.status, 0, first.stderr);
    const capsulePath = path.join(root, "controller-artifacts", "capsule.v1.json");
    const capsule = JSON.parse(await fs.readFile(capsulePath, "utf8"));
    capsule.role = "executor";
    capsule.roleStatus = "READY_FOR_VERIFICATION";
    capsule.status = "READY_FOR_VERIFICATION";
    await fs.writeFile(capsulePath, `${JSON.stringify(capsule)}\n`, "utf8");
    const invalid = run(root);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /planner result capsule|planner\/NEEDS_EVIDENCE/);
    assert.equal(await fs.readFile(path.join(root, "dispatch-count"), "utf8"), "1");
  });
});

test("unavailable suspension writes a stop record and dispatches zero providers", async () => {
  await withFixture(async (root) => {
    const result = run(root, { suspensionAvailable: "false" });
    assert.equal(result.status, 1);
    assert.equal(result.json.status, "BLOCKED");
    assert.equal(result.json.controller.suspensionStatus, "unavailable");
    assert.equal(result.json.controller.dispatchCount, 0);
    assert.equal(result.json.controller.capsulePath, null);
    await assert.rejects(fs.stat(path.join(root, "dispatch-count")));
    await fs.stat(path.join(root, "controller-artifacts", "suspension-stop.v1.json"));
  });
});
