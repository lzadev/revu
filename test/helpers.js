import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'revu.js');
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

// A throw-away repo (+ isolated HOME so user config / trust store never touch the real ones)
export function makeRepo({ base = { 'README.md': 'x\n' }, staged = {}, config = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'revu-sec-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'revu-home-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  const write = files => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } };
  write(base); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'init', '--no-verify');
  write(config); write(staged); git(dir, 'add', '.');
  return { dir, home };
}

export function userConfig(home, yaml) {
  fs.mkdirSync(path.join(home, '.config', 'revu'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'revu', 'config.yaml'), yaml);
}

export function runRevu({ dir, home }, args = [], env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, CLAUDECODE: '', CI: '', REVU_SKIP: '', REVU_PLAIN: '', LANG: 'en_US.UTF-8', ...env },
    });
    let out = '';
    child.stdout.on('data', d => (out += d)); child.stderr.on('data', d => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Fake OpenAI-compatible LLM. `respond(system, user)` returns the review object it should "produce".
export async function startLLM(respond = () => ({ summary: 's', walkthrough: [], findings: [] })) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let system = '', user = '', model = 'm';
      try { const j = JSON.parse(body); model = j.model || 'm'; const m = j.messages; system = m[0].content; user = m.at(-1).content; } catch {}
      seen.push({ headers: req.headers, system, user });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model, usage: { prompt_tokens: 1234, completion_tokens: 56 }, choices: [{ message: { content: JSON.stringify(respond(system, user)) } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}
