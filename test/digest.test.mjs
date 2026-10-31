import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../scripts/digest.mjs');
const now = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function tmpDir(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-system-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

function runDigest(t, contents, extra = [], { withOut = true } = {}) {
  const tmp = tmpDir(t);
  const root = path.join(tmp, 'projects');
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  for (const [name, body] of Object.entries(contents)) fs.writeFileSync(path.join(project, name), body);
  const out = path.join(tmp, 'result.md');
  const args = [script, '--root', root, '--state', path.join(tmp, 'state'), ...(withOut ? ['--out', out] : []), ...extra];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const report = withOut && fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  return { result, out, tmp, report };
}

const event = (type, content, more = {}) =>
  JSON.stringify({ type, timestamp: now, cwd: '/tmp/project', message: { content }, ...more });
const lines = (...l) => l.join('\n');

test('groups close requests across sessions and masks common secrets', (t) => {
  const a = lines(event('user', 'Can you add the unit tests for this PHP service please?'), event('user', 'Use the token ' + 'sk_live' + '_1234567890abcdefghijklmnop in this test'));
  const b = event('user', 'Can you add some unit tests for this PHP service please?');
  const { result, out, report } = runDigest(t, { 'one.jsonl': a, 'two.jsonl': b });
  assert.equal(result.status, 0, result.stderr);
  assert.match(report, /2 sessions, 2 occurrences, 2 close wordings/);
  assert.match(report, /\[SECRET\]/);
  assert.doesNotMatch(report, /sk_live_/);
  assert.match(report, /Active time = estimate/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test('does not group different requests', (t) => {
  const a = event('user', 'Add pagination to the customer invoice list');
  const b = event('user', 'Clear the Redis cache before every production deploy');
  const { report } = runDigest(t, { 'a.jsonl': a, 'b.jsonl': b });
  assert.doesNotMatch(report, /Messages repeated/);
});

test('masks secrets in session titles', (t) => {
  const body = lines(JSON.stringify({ type: 'summary', summary: 'Config token=ghp_abcdefghijklmnopqrstuvwxyz123456' }), event('user', 'Hello there everyone'));
  const { result, report } = runDigest(t, { 's.jsonl': body });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(report, /ghp_abc/);
  assert.match(report, /\[SECRET\]/);
});

test('skips messages copied by a resumed session', (t) => {
  const original = event('user', 'Add zod validation to the contact form', { uuid: 'u-1' });
  const { result, report } = runDigest(t, {
    'a.jsonl': original,
    'b.jsonl': lines(original, event('user', 'Now add an e2e test for this form', { uuid: 'u-2' })),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(report, /Messages repeated/);
  assert.match(report, /1 events duplicated/);
  assert.match(report, /^2 sessions/m);
});

test('reports malformed JSONL lines without stopping', (t) => {
  const { result, report } = runDigest(t, { 'broken.jsonl': `${event('user', 'Hello there everyone')}\n{invalid-json` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(report, /1 malformed JSONL lines skipped/);
});

test('skips events older than the requested window', (t) => {
  const body = lines(event('user', 'Old message that must be skipped', { timestamp: daysAgo(30) }), event('user', 'Recent message to keep'));
  const { report } = runDigest(t, { 's.jsonl': body }, ['--days', '7']);
  assert.match(report, /Recent message/);
  assert.doesNotMatch(report, /Old message/);
});

test('counts corrections, interruptions, tool errors and permission denials', (t) => {
  const body = lines(
    event('user', 'Add a login button'),
    event('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash' }, { type: 'tool_use', id: 't2', name: 'Edit' }]),
    event('user', [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'command not found' }]),
    event('user', [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'The user doesn\'t want to proceed' }]),
    event('user', '[Request interrupted by user]'),
    event('user', 'No, I already told you to use pnpm'),
  );
  const { report } = runDigest(t, { 's.jsonl': body });
  assert.match(report, /1 ⚠️, 1 ⏹, errors: Bash ×1, 1 permission denials/);
  assert.match(report, /- ⚠️ No, I already told you/);
  assert.match(report, /- ⏹ interrupted/);
  assert.match(report, /## Errors by tool\n\nBash ×1/);
});

test('skips /improve-system sessions, even with a plugin prefix', (t) => {
  const cmd = (name) => event('user', `<command-name>/${name}</command-name><command-args>14</command-args>`);
  const contents = {
    'a.jsonl': lines(cmd('improve-system'), event('user', 'Run the full report now')),
    'b.jsonl': lines(cmd('shared-skills:improve-system'), event('user', 'Run the full report now')),
    'c.jsonl': event('user', 'Regular work on the project'),
  };
  const { report } = runDigest(t, contents);
  assert.match(report, /^1 sessions \(2 \/improve-system sessions skipped\)/m);
  const all = runDigest(t, contents, ['--include-self']).report;
  assert.match(all, /^3 sessions/m);
});

test('detects instruction files and the @AGENTS.md import', (t) => {
  const tmp = tmpDir(t);
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '@./AGENTS.md\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Rules\n');
  const { report } = runDigest(t, { 's.jsonl': event('user', 'Hello there everyone', { cwd: repo }) });
  assert.match(report, /CLAUDE\.md \(imports @AGENTS\.md\), .*AGENTS\.md/);
});

test('stays within budget by leaving out the oldest sessions', (t) => {
  const contents = {};
  for (let i = 0; i < 40; i++) contents[`s${i}.jsonl`] = event('user', `Session ${i}: ${'detail '.repeat(150)}`);
  const { result, report } = runDigest(t, contents, ['--max-chars', '5000']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(report.length <= 5000 + 20, `size ${report.length}`);
  assert.match(report, /truncated: \d+ oldest sessions left out/);
});

test('writes to a private temp folder by default', (t) => {
  const { result } = runDigest(t, { 's.jsonl': event('user', 'Hello there everyone') }, [], { withOut: false });
  assert.equal(result.status, 0, result.stderr);
  const file = result.stdout.split(': ')[0];
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('accepts --option=value and rejects unknown options', (t) => {
  const body = { 's.jsonl': event('user', 'Hello there everyone') };
  assert.equal(runDigest(t, body, ['--days=14']).result.status, 0);
  const bad = runDigest(t, body, ['--dayz', '14']).result;
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option: --dayz/);
});

test('rejects an invalid output limit', (t) => {
  const { result } = runDigest(t, { 'one.jsonl': event('user', 'Hello there everyone') }, ['--max-chars', 'NaN']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /max-chars must be an integer/);
});

test('rejects an out-of-range number of days', (t) => {
  const { result } = runDigest(t, { 'one.jsonl': event('user', 'Hello there everyone') }, ['--days', '120']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /days must be an integer between 1 and 90/);
});
