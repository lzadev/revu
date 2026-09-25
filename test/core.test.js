import assert from 'node:assert/strict';
import test from 'node:test';
import { globToRegExp, matchesAny } from '../src/glob.js';
import { parseDiff } from '../src/diff.js';
import { extractJson } from '../src/providers.js';
import { mdLines } from '../src/ui.js';

test('glob', () => {
  assert.ok(matchesAny('src/a/b.tsx', ['src/**/*.{ts,tsx}']));
  assert.ok(matchesAny('src/b.ts', ['src/**/*.{ts,tsx}']));
  assert.ok(!matchesAny('lib/b.ts', ['src/**/*.{ts,tsx}']));
  assert.ok(globToRegExp('**/dist/**').test('web/dist/x/y.js'));
  assert.ok(!globToRegExp('*.js').test('a/b.js'));
});

test('parseDiff numbers lines on the new side', () => {
  const d = parseDiff([
    'diff --git a/x.js b/x.js', 'index 1..2 100644', '--- a/x.js', '+++ b/x.js',
    '@@ -1,3 +1,4 @@ fn', ' a', '-b', '+B', '+C', ' d', '',
  ].join('\n'));
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].hunks[0].lines.map(l => [l.type, l.newNo ?? null]), [['ctx', 1], ['del', null], ['add', 2], ['add', 3], ['ctx', 4]]);
  assert.equal(d[0].additions, 2);
});

test('extractJson tolerates fences and chatter', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```\nbye'), { a: 1 });
});

test('mdLines keeps spans styled across wrapped lines', () => {
  const [a, b] = mdLines(['use `foo bar', 'baz` now']);
  assert.ok(!a.includes('`') && !b.includes('`'));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandProvider } from '../src/providers.js';
import { loadConfig, scopedGuidelines } from '../src/config.js';

test('provider shorthand', () => {
  assert.equal(expandProvider('claude').type, 'command');
  assert.deepEqual(
    (({ type, base_url, model, num_ctx }) => ({ type, base_url, model, num_ctx }))(expandProvider('ollama:qwen2.5-coder:14b')),
    { type: 'ollama', base_url: 'http://localhost:11434', model: 'qwen2.5-coder:14b', num_ctx: 16384 });
  assert.equal(expandProvider('command:my-llm --fast').command, 'my-llm --fast');
  assert.throws(() => expandProvider('ollama'), /needs a model/);
  assert.throws(() => expandProvider('nope'), /Unknown provider/);
});

test('rules discovery: root files, .revu/rules with paths, nested AGENTS.md', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revu-'));
  fs.mkdirSync(path.join(root, '.revu/rules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web/ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'ROOT RULE');
  fs.writeFileSync(path.join(root, 'web/AGENTS.md'), 'WEB RULE');
  fs.writeFileSync(path.join(root, '.revu/rules/a.md'), 'GLOBAL TOPIC');
  fs.writeFileSync(path.join(root, '.revu/rules/b.md'), '---\npaths: [api/**]\n---\nAPI ONLY');
  fs.writeFileSync(path.join(root, '.revu.local.yaml'), 'provider: claude\n');

  const cfg = loadConfig(root);
  assert.equal(cfg.provider.type, 'command');
  assert.match(cfg._guidelinesText, /ROOT RULE/);
  assert.match(cfg._guidelinesText, /GLOBAL TOPIC/);
  assert.doesNotMatch(cfg._guidelinesText, /API ONLY/);
  assert.ok(cfg.path_instructions.some(p => p.path === 'api/**' && /API ONLY/.test(p.instructions)));

  const scoped = scopedGuidelines(root, ['web/ui/x.tsx', 'other/y.ts']);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].path, 'web/**');
});
