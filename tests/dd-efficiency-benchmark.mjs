// Synthetic mechanical comparison, not a model token/quota benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { snapshotData } from '../skills/deliberate-delegate/scripts/dd-efficiency.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(source, 'tests/.dd-efficiency-scratch');
const helper = path.join(source, 'skills/deliberate-delegate/scripts/dd-efficiency.mjs');
await fs.mkdir(scratch, { recursive: true });
function call(root, executable, args) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { ...result, bytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) };
}
const rows = [];
for (const scenario of ['success', 'unexpected-path', 'validator-failure']) {
  const root = await fs.mkdtemp(path.join(scratch, 'benchmark-'));
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) assert.equal(call(root, 'git', args).status, 0);
  await fs.writeFile(path.join(root, 'allowed.txt'), 'old\n'.repeat(500));
  const validatorCode = `process.stdout.write('validator evidence\\n'.repeat(4000)); process.exit(${scenario === 'validator-failure' ? 1 : 0})`;
  await fs.writeFile(path.join(root, 'validators.json'), JSON.stringify([{ name: 'fixture', executable: process.execPath, args: ['-e', validatorCode] }]));
  assert.equal(call(root, 'git', ['add', '.']).status, 0);
  assert.equal(call(root, 'git', ['commit', '-qm', 'baseline']).status, 0);
  const baseline = await snapshotData(root);
  await fs.writeFile(path.join(root, 'baseline.json'), JSON.stringify(baseline));
  await fs.writeFile(path.join(root, 'allowed.txt'), 'new\n'.repeat(500));
  if (scenario === 'unexpected-path') await fs.writeFile(path.join(root, 'unexpected.txt'), 'out of scope\n');

  // Baseline exposes the same status, patches, content/identity snapshot and
  // validator output through five separate host invocations.
  const separate = [
    call(root, 'git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    call(root, 'git', ['--no-optional-locks', 'diff', '--no-ext-diff', '--binary', '--full-index']),
    call(root, 'git', ['--no-optional-locks', 'diff', '--cached', '--no-ext-diff', '--binary', '--full-index']),
    call(root, process.execPath, ['--input-type=module', '-e', `import {snapshotData} from ${JSON.stringify(pathToFileURL(helper).href)}; console.log(JSON.stringify(await snapshotData(process.cwd())));`]),
    call(root, process.execPath, ['-e', validatorCode]),
  ];
  for (const result of separate.slice(0, 4)) assert.equal(result.status, 0, result.stderr);
  const current = JSON.parse(separate[3].stdout);
  const changed = [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])]
    .filter((name) => name !== 'baseline.json' && JSON.stringify(baseline.files[name]) !== JSON.stringify(current.files[name]));
  const unexpected = changed.filter((name) => name !== 'allowed.txt');
  const sameIdentity = JSON.stringify(baseline.git) === JSON.stringify(current.git);
  const baselineVerdict = unexpected.length === 0 && sameIdentity && separate[4].status === 0 ? 'PASS' : 'FAIL';
  const batched = call(root, process.execPath, [helper, 'gate', '--root', root, '--baseline', 'baseline.json', '--allow', 'allowed.txt', '--validators', 'validators.json', '--artifact-dir', 'raw/gate']);
  const summary = JSON.parse(batched.stdout);
  assert.equal(summary.status, baselineVerdict);
  assert.equal(summary.counts.unexpected, unexpected.length);
  assert.equal(summary.validators[0].exitCode, separate[4].status);
  assert.equal(await fs.readFile(path.join(root, 'raw/gate/validator-01.stdout.log'), 'utf8'), separate[4].stdout);
  assert.ok(batched.bytes <= 8192);
  rows.push({ scenario, verdict: summary.status, separateHostInvocations: separate.length, batchedHostInvocations: 1, separateVisibleBytes: separate.reduce((sum, item) => sum + item.bytes, 0), batchedVisibleBytes: batched.bytes });
}
console.log(JSON.stringify({ kind: 'synthetic-mechanical-only', node: process.version, platform: process.platform, rows, limits: 'Counts exclude identical baseline/setup work. Internal Git/validator subprocesses still execute. Visible bytes are not tokens. No LLM calls, quota measurement, live project or claimed end-to-end savings.' }, null, 2));
