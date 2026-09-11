import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runAdapter, buildIndex, drainLogs } from '../skills/deliberate-delegate/scripts/dd-efficiency.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(source, 'tests/.dd-efficiency-scratch');
const helper = path.join(source, 'skills/deliberate-delegate/scripts/dd-efficiency.mjs');
async function fixture() { await fs.mkdir(scratch, { recursive: true }); return fs.mkdtemp(path.join(scratch, 'runner-')); }
const program = (value, exit = 0) => `require('fs').appendFileSync('dispatches','1'); require('fs').writeFileSync('result.json',${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))}); console.log('raw evidence'); process.exit(${exit});`;

test('AC-5: terminal result, process exit, session, malformed/missing/stale and single dispatch', async () => {
  const cases = [
    ['success', { status: 'completed', exitCode: 0, threadId: 'fixed' }, 0, 'PASS'],
    ['process failure', { status: 'completed', exitCode: 0, threadId: 'fixed' }, 9, 'FAIL'],
    ['failed status', { status: 'failed', exitCode: 1, threadId: 'fixed' }, 0, 'FAIL'],
    ['nonterminal', { status: 'running', exitCode: 0 }, 0, 'FAIL'],
    ['wrong session', { status: 'completed', exitCode: 0, sessionId: 'different' }, 0, 'FAIL'],
    ['inconsistent result exit', { status: 'completed', exitCode: 8, sessionId: 'fixed' }, 0, 'FAIL'],
    ['missing result exit', { status: 'completed', sessionId: 'fixed' }, 0, 'FAIL'],
    ['malformed', '{broken', 0, 'FAIL'],
  ];
  for (const [name, value, exit, expected] of cases) {
    const root = await fixture();
    const result = await runAdapter({ root, adapter: process.execPath, args: ['-e', program(value, exit)], result: 'result.json', artifactDir: 'raw/attempt-01', expectedSession: 'fixed', timeoutMs: 5000 });
    assert.equal(result.status, expected, name);
    assert.equal(result.dispatchCount, 1);
    assert.equal(await fs.readFile(path.join(root, 'dispatches'), 'utf8'), '1');
    assert.equal(await fs.readFile(path.join(root, 'result.json'), 'utf8'), typeof value === 'string' ? value : JSON.stringify(value));
    assert.match(await fs.readFile(path.join(root, 'raw/attempt-01/adapter.stdout.log'), 'utf8'), /raw evidence/);
    assert.ok(Buffer.byteLength(JSON.stringify(result) + '\n') <= 8192);
    const stale = await runAdapter({ root, adapter: process.execPath, args: ['-e', program(value)], result: 'result.json', artifactDir: 'raw/attempt-02' });
    assert.equal(stale.status, 'FAIL'); assert.equal(stale.dispatchCount, 0);
    assert.equal(await fs.readFile(path.join(root, 'dispatches'), 'utf8'), '1');
  }
  for (const [name, args, timeoutMs] of [['missing', ['-e', 'console.log("no result")'], 5000], ['timeout', ['-e', 'setInterval(()=>{},1000)'], 100]]) {
    const root = await fixture();
    const result = await runAdapter({ root, adapter: process.execPath, args, result: 'result.json', artifactDir: 'raw/attempt', timeoutMs });
    assert.equal(result.status, 'FAIL', name);
    if (name === 'timeout') assert.equal(result.process.timedOut, true);
  }
});

test('CLI run honors dashed arguments and failure exit status', async () => {
  for (const expectedSession of ['fixed', 'wrong']) {
    const root = await fixture();
    const result = spawnSync(process.execPath, [helper, 'run', '--root', root, '--adapter', process.execPath, '--args-json', JSON.stringify(['-e', program({ status: 'completed', exitCode: 0, sessionId: 'fixed' })]), '--result', 'result.json', '--artifact-dir', 'raw/custom', '--expected-session', expectedSession, '--timeout-ms', '5000'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, expectedSession === 'fixed' ? 0 : 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).artifactDir, 'raw/custom');
  }
});

test('CLI job uses the controller path and fails closed when host waiting is unavailable', async () => {
  const root = await fixture();
  const success = spawnSync(process.execPath, [helper, 'job', '--root', root, '--adapter', process.execPath, '--args-json', JSON.stringify(['-e', program({ status: 'completed', exitCode: 0, sessionId: 'fixed' })]), '--result', 'result.json', '--artifact-dir', 'raw/job', '--expected-session', 'fixed', '--suspension-available', 'true', '--timeout-ms', '5000'], { encoding: 'utf8', windowsHide: true });
  assert.equal(success.status, 0, success.stderr);
  const parsed = JSON.parse(success.stdout);
  assert.equal(parsed.status, 'PASS');
  assert.equal(parsed.dispatchCount, 1);
  assert.equal(parsed.suspensionStatus, 'unknown');
  assert.ok(parsed.capsulePath);
  const reused = spawnSync(process.execPath, [helper, 'job', '--root', root, '--adapter', process.execPath, '--args-json', JSON.stringify(['-e', program({ status: 'completed', exitCode: 0, sessionId: 'fixed' })]), '--result', 'result.json', '--artifact-dir', 'raw/job', '--expected-session', 'fixed', '--suspension-available', 'true', '--timeout-ms', '5000'], { encoding: 'utf8', windowsHide: true });
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(JSON.parse(reused.stdout).status, 'REUSED');
  assert.equal(await fs.readFile(path.join(root, 'dispatches'), 'utf8'), '1');

  const stoppedRoot = await fixture();
  const stopped = spawnSync(process.execPath, [helper, 'job', '--root', stoppedRoot, '--adapter', process.execPath, '--args-json', JSON.stringify(['-e', program({ status: 'completed', exitCode: 0 })]), '--result', 'result.json', '--artifact-dir', 'raw/stopped', '--suspension-available', 'false', '--timeout-ms', '5000'], { encoding: 'utf8', windowsHide: true });
  assert.equal(stopped.status, 1, stopped.stderr);
  const stoppedParsed = JSON.parse(stopped.stdout);
  assert.equal(stoppedParsed.status, 'UNAVAILABLE');
  assert.equal(stoppedParsed.dispatchCount, 0);
  await assert.rejects(fs.stat(path.join(stoppedRoot, 'dispatches')));

  const missingFlagRoot = await fixture();
  const missingFlag = spawnSync(process.execPath, [helper, 'job', '--root', missingFlagRoot, '--adapter', process.execPath, '--args-json', '[]', '--result', 'result.json', '--artifact-dir', 'raw/missing-flag'], { encoding: 'utf8', windowsHide: true });
  assert.equal(missingFlag.status, 2);
  assert.match(missingFlag.stderr, /suspension-available/);
});

test('missing expected session reports unchecked continuity in a non-repository root', async () => {
  const root = await fixture();
  const result = await runAdapter({ root, adapter: process.execPath, args: ['-e', program({ status: 'completed', exitCode: 0 })], result: 'result.json', artifactDir: 'raw/no-session' });
  assert.equal(result.status, 'PASS');
  assert.equal(result.sessionVerification, 'not_requested');
  assert.ok(result.coverageLimits.some((value) => value.includes('Session continuity was not checked')));
});

test('held-open log stream is bounded and closed on drain timeout', async () => {
  const source = new PassThrough();
  const sink = new Writable({ write(chunk, encoding, done) { done(); } });
  const log = pipeline(source, sink).catch(() => {});
  source.write('partial evidence');
  assert.equal(await drainLogs([log], [source, sink], 40), true);
  assert.equal(source.destroyed, true);
  assert.equal(sink.destroyed, true);
});

test('inherited descendant pipes have a bounded drain after owned-process exit', { timeout: 12000, skip: process.platform === 'win32' ? 'Native Node Windows inheritance did not retain the pipe; drain timeout tested separately with a held-open stream' : false }, async () => {
  const root = await fixture();
  const code = `require('fs').writeFileSync('result.json',JSON.stringify({status:'completed',exitCode:0,sessionId:'fixed'})); require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},7000)'],{stdio:['ignore',1,2],windowsHide:true}); process.exit(0);`;
  const started = Date.now();
  const result = await runAdapter({ root, adapter: process.execPath, args: ['-e', code], result: 'result.json', artifactDir: 'raw/descendant', expectedSession: 'fixed', timeoutMs: 10000 });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.process.logDrainTimedOut, true);
  assert.ok(Date.now() - started < 6500, 'helper must not await descendant pipe closure');
});

test('AC-6: index preserves immutable bytes, links state/records/raw, and safely regenerates', async () => {
  const root = await fixture();
  const records = ['state.json', 'authorization.v1.md', 'plan.v1.md', 'brief.v1.md', 'decision.v1.md', 'debate.pre.v1.md', 'raw/attempt-01/planner2-run.result.json'];
  for (const relative of records) {
    const target = path.join(root, 'records', relative);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, `immutable ${relative}\n`);
  }
  await buildIndex({ root, records: 'records', out: 'records/INDEX.generated.md' });
  await buildIndex({ root, records: 'records', out: 'records/INDEX.generated.md' });
  const index = await fs.readFile(path.join(root, 'records/INDEX.generated.md'), 'utf8');
  assert.match(index, /non-authoritative/); assert.match(index, /cannot authorize/); assert.match(index, /evidence, never permission/);
  for (const relative of records) {
    assert.ok(index.includes(relative));
    assert.equal(await fs.readFile(path.join(root, 'records', relative), 'utf8'), `immutable ${relative}\n`);
  }
  await assert.rejects(buildIndex({ root, records: 'records', out: 'records/plan.v1.md' }), /immutable/);
});
