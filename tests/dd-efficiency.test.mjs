import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  GENERATED_INDEX_MARKER,
  buildIndex,
  runAdapter,
  runGate,
  snapshotData,
} from "../skills/deliberate-delegate/scripts/dd-efficiency.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoot = path.join(sourceRoot, "tests", ".dd-efficiency-scratch");
const helperPath = path.join(sourceRoot, "skills", "deliberate-delegate", "scripts", "dd-efficiency.mjs");

async function command(cwd, executable, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function git(cwd, args) {
  const result = await command(cwd, "git", args);
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.replaceAll("\\", "/").split("/"));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content);
}

async function fixture({ stagedDirty = false, unstagedDirty = false } = {}) {
  await fsp.mkdir(scratchRoot, { recursive: true });
  const root = await fsp.mkdtemp(path.join(scratchRoot, "fixture-"));
  await git(root, ["init", "--initial-branch=main", "-q"]);
  await git(root, ["config", "user.email", "dd-test@example.invalid"]);
  await git(root, ["config", "user.name", "Deliberate Delegate Test"]);
  await write(root, "src/allowed file.txt", "allowed baseline\n");
  await write(root, "src/unicode-Δ.txt", "unicode baseline\n");
  await write(root, "src/prefix", "prefix baseline\n");
  await write(root, "src/prefix-extra", "prefix-extra baseline\n");
  await write(root, "delete me.txt", "delete baseline\n");
  await write(root, "rename source.txt", "rename baseline\n");
  await write(root, "stage me.txt", "stage baseline\n");
  await write(root, "pre-existing staged.txt", "staged baseline\n");
  await write(root, "pre-existing unstaged.txt", "unstaged baseline\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline", "-q"]);
  if (stagedDirty) {
    await write(root, "pre-existing staged.txt", "staged baseline plus prior dirt\n");
    await git(root, ["add", "pre-existing staged.txt"]);
  }
  if (unstagedDirty) await write(root, "pre-existing unstaged.txt", "unstaged baseline plus prior dirt\n");
  return root;
}

async function saveSnapshot(root, relative = ".dd-efficiency/snapshot.json") {
  const data = await snapshotData(root);
  const absolute = path.join(root, ...relative.split("/"));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, `${JSON.stringify(data, null, 2)}\n`);
  return relative;
}

async function withFixture(options, fn) {
  const root = await fixture(options);
  try {
    return await fn(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function gateOptions(root, baseline, artifactDir, allow, extra = {}) {
  return { root, baseline, artifactDir, allow, timeoutMs: 5000, maxSummaryBytes: 8192, ...extra };
}

test("gate checks validator writes, rejects hidden scope, and preserves full fingerprint evidence", async () => {
  await withFixture({}, async (root) => {
    const baseline = await saveSnapshot(root);
    await assert.rejects(runGate(gateOptions(root, baseline, ".dd-efficiency/overlap", ["src"], { exclude: ["src"] })), /overlaps allowlist/);
    const summary = await runGate(gateOptions(root, baseline, ".dd-efficiency/validator-write", ["src"], {
      validatorJson: [JSON.stringify({ name: "write outside scope", executable: process.execPath, args: ["-e", "require('fs').writeFileSync('outside.txt','unexpected')"] })],
    }));
    assert.equal(summary.status, "FAIL");
    assert.ok(summary.unexpectedPaths.items.includes("outside.txt"));
    const changes = JSON.parse(await fsp.readFile(path.join(root, summary.artifactDir, "fingerprint-changes.json"), "utf8"));
    assert.equal(changes.find((item) => item.path === "outside.txt").after.kind, "file");
    assert.ok(summary.detailsPath);
  });
});

test("snapshot rejects implicit widening from a subdirectory", async () => {
  await withFixture({}, async (root) => {
    await assert.rejects(snapshotData(path.join(root, "src")), /explicit repository root/);
  });
});

test("explicit ignored binary scope is fingerprinted; changed pre-existing untracked dirt fails", async () => {
  await withFixture({}, async (root) => {
    await write(root, ".gitignore", "src/ignored.bin\n");
    await write(root, "prior-untracked.txt", "prior\n");
    await write(root, "src/ignored.bin", Buffer.from([0, 255, 1]));
    const snapshot = await snapshotData(root, { allow: ["src"] });
    assert.equal(snapshot.files["src/ignored.bin"].kind, "file");
    await write(root, "baseline.json", JSON.stringify(snapshot));
    await write(root, "src/ignored.bin", Buffer.from([0, 255, 2]));
    await write(root, "prior-untracked.txt", "changed\n");
    const result = await runGate(gateOptions(root, "baseline.json", ".dd-efficiency/ignored", ["src"]));
    assert.equal(result.status, "FAIL");
    assert.equal(result.counts.allowedChanged, 1);
    assert.ok(result.unexpectedPaths.items.includes("prior-untracked.txt"));
  });
});

test("AC-1: content allowlist handles deletion, rename, staged baseline dirt, Unicode/spaces, and prefix collisions", async () => {
  await withFixture({ stagedDirty: true, unstagedDirty: true }, async (root) => {
    const baseline = await saveSnapshot(root);
    await write(root, "src/allowed file.txt", "allowed changed\n");
    await write(root, "src/unicode-Δ.txt", "unicode changed\n");
    await fsp.rm(path.join(root, "delete me.txt"));
    await fsp.rename(path.join(root, "rename source.txt"), path.join(root, "src", "renamed file.txt"));
    await write(root, "src/new file.txt", "new untracked\n");
    const passing = await runGate(gateOptions(root, baseline, ".dd-efficiency/gate-pass", ["src", "delete me.txt", "rename source.txt"]));
    assert.equal(passing.status, "PASS");
    assert.equal(passing.counts.unexpected, 0);
    assert.ok(passing.counts.unchangedExistingDirty >= 2);

    await write(root, "src/prefix-extra", "prefix-extra changed\n");
    const prefix = await runGate(gateOptions(root, baseline, ".dd-efficiency/gate-prefix", ["src/prefix"]));
    assert.equal(prefix.status, "FAIL");
    assert.ok(prefix.unexpectedPaths.items.includes("src/prefix-extra"));
  });
});

test("AC-1: a new staged edit fails through index identity even when its path is allowed", async () => {
  await withFixture({}, async (root) => {
    const baseline = await saveSnapshot(root);
    await write(root, "stage me.txt", "new staged content\n");
    await git(root, ["add", "stage me.txt"]);
    const result = await runGate(gateOptions(root, baseline, ".dd-efficiency/gate-staged", ["stage me.txt"]));
    assert.equal(result.status, "FAIL");
    assert.ok(result.identityFailures.items.some((entry) => entry.startsWith("indexHash:")));
  });
});

test("AC-2: failing/missing validators and changed Git identity never pass", async () => {
  await withFixture({}, async (root) => {
    const baseline = await saveSnapshot(root);
    const failing = await runGate(gateOptions(root, baseline, ".dd-efficiency/gate-validator-fail", ["src"], {
      validatorJson: [JSON.stringify({ name: "fail", executable: process.execPath, args: ["-e", "process.stderr.write('validator failed'); process.exit(7)"] })],
    }));
    assert.equal(failing.status, "FAIL");
    assert.equal(failing.counts.validatorFailures, 1);
    assert.equal(failing.validators[0].exitCode, 7);

    const missing = await runGate(gateOptions(root, baseline, ".dd-efficiency/gate-validator-missing", ["src"], {
      validatorJson: [JSON.stringify({ name: "missing", executable: "definitely-not-installed-dd-validator", args: [] })],
    }));
    assert.equal(missing.status, "FAIL");
    assert.equal(missing.validators[0].status, "FAIL");

    await git(root, ["checkout", "-b", "unexpected-branch", "-q"]);
    const identity = await runGate(gateOptions(root, baseline, ".dd-efficiency/gate-identity", ["src"]));
    assert.equal(identity.status, "FAIL");
    assert.ok(identity.identityFailures.items.some((entry) => entry.startsWith("branch:")));
  });
});

test("AC-3: large diagnostics stay bounded while raw status/diff/validator evidence remains complete", async () => {
  await withFixture({}, async (root) => {
    const baseline = await saveSnapshot(root);
    const unexpected = [];
    for (let index = 0; index < 140; index += 1) {
      const relative = `unexpected directory ${index}/file ${index}.txt`;
      unexpected.push(relative);
      await write(root, relative, `unexpected ${index}\n`);
    }
    const largeStdout = "X".repeat(24000);
    const largeStderr = "Y".repeat(12000);
    await write(root, "large-validator.mjs", `process.stdout.write(${JSON.stringify(largeStdout)}); process.stderr.write(${JSON.stringify(largeStderr)});\n`);
    const result = await runGate(gateOptions(root, baseline, ".dd-efficiency/gate-large", ["src"], {
      validatorJson: [JSON.stringify({ name: "large", executable: process.execPath, args: ["large-validator.mjs"] })],
    }));
    assert.equal(result.status, "FAIL");
    const summaryBytes = (await fsp.stat(path.join(root, result.summaryPath))).size;
    assert.ok(summaryBytes <= 8192, `summary is ${summaryBytes} bytes`);
    const rawUnexpected = JSON.parse((await fsp.readFile(path.join(root, result.unexpectedPaths.rawLocator), "utf8")));
    assert.equal(rawUnexpected.length, unexpected.length + 1); // large-validator.mjs is also a new untracked path
    assert.equal(result.validators[0].stdoutBytes, Buffer.byteLength(largeStdout));
    assert.equal(result.validators[0].stderrBytes, Buffer.byteLength(largeStderr));
    assert.equal((await fsp.stat(path.join(root, result.validators[0].stdoutPath))).size, Buffer.byteLength(largeStdout));
    assert.equal((await fsp.stat(path.join(root, result.validators[0].stderrPath))).size, Buffer.byteLength(largeStderr));
    const statusRaw = await fsp.readFile(path.join(root, result.rawPaths[0]));
    assert.ok(statusRaw.includes(Buffer.from("?? unexpected directory")));
  });
});

test("AC-4: traversal, scope-overlap, symlink output, and immutable-index overwrites are rejected", async (t) => {
  await withFixture({}, async (root) => {
    const baseline = await saveSnapshot(root);
    await assert.rejects(
      runGate(gateOptions(root, baseline, "../outside-gate", ["src"])),
      (error) => error.code === "E_PATH_TRAVERSAL",
    );
    await assert.rejects(
      runGate(gateOptions(root, baseline, ".dd-efficiency/gate-overlap", ["."])),
      (error) => error.code === "E_SCOPE_OVERLAP",
    );
    assert.equal(await fsp.stat(path.join(root, ".dd-efficiency/gate-overlap")).catch(() => null), null);

    await write(root, "docs/immutable-record.md", "immutable record\n");
    await assert.rejects(
      buildIndex({ root, records: "docs", out: "docs/immutable-record.md" }),
      (error) => error.code === "E_IMMUTABLE",
    );

    const outside = await fsp.mkdtemp(path.join(scratchRoot, "outside-"));
    const link = path.join(root, "owned-output-link");
    try {
      await fsp.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      await fsp.rm(outside, { recursive: true, force: true });
      t.skip(`symlink/junction creation unavailable on this host: ${error.code || error.message}`);
      return;
    }
    try {
      await assert.rejects(
        runAdapter({ root, adapter: process.execPath, args: ["-e", ""], result: "result.json", artifactDir: "owned-output-link/run", timeoutMs: 100 }),
        (error) => error.code === "E_SYMLINK",
      );
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

test("CLI snapshot writes a fresh project-relative baseline", async () => {
  await withFixture({}, async (root) => {
    const result = await command(sourceRoot, process.execPath, [helperPath, "snapshot", "--root", root, "--out", ".dd-efficiency/cli-snapshot.json"]);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "PASS");
    assert.equal(parsed.snapshotPath, ".dd-efficiency/cli-snapshot.json");
    assert.ok((await fsp.stat(path.join(root, ".dd-efficiency/cli-snapshot.json")).catch(() => null))?.isFile());
  });
});
