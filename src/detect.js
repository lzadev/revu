import { execFileSync } from 'node:child_process';

export const has = cmd => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

async function probe(url, ms = 900) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}

export const preferCoder = models => [...models].sort((a, b) => /coder|code/i.test(b) - /coder|code/i.test(a));

// What can this machine use right now? `spec` is set when no further choice is needed.
export async function detectProviders() {
  const found = [];
  const ollama = await probe('http://localhost:11434/api/tags');
  if (ollama?.models?.length) found.push({ id: 'ollama', label: 'Ollama (local, free)', hint: `${ollama.models.length} model(s)`, models: preferCoder(ollama.models.map(m => m.name)), prefix: 'ollama:' });
  const lm = await probe('http://localhost:1234/v1/models');
  if (lm?.data?.length) found.push({ id: 'lmstudio', label: 'LM Studio (local, free)', hint: 'server on :1234', models: preferCoder(lm.data.map(m => m.id)), prefix: 'lmstudio:' });
  if (has('claude')) found.push({ id: 'claude', label: 'Claude Code CLI (your subscription)', hint: 'claude -p', spec: 'claude' });
  if (has('codex')) found.push({ id: 'codex', label: 'Codex CLI (your subscription)', hint: 'preset, untested', spec: 'codex' });
  if (has('gemini')) found.push({ id: 'gemini', label: 'Gemini CLI', hint: 'preset, untested', spec: 'gemini' });
  if (process.env.ANTHROPIC_API_KEY) found.push({ id: 'anthropic', label: 'Anthropic API', hint: 'ANTHROPIC_API_KEY', spec: 'anthropic' });
  if (process.env.OPENAI_API_KEY) found.push({ id: 'openai', label: 'OpenAI API', hint: 'OPENAI_API_KEY', spec: 'openai' });
  if (process.env.OPENROUTER_API_KEY) found.push({ id: 'openrouter', label: 'OpenRouter', hint: 'OPENROUTER_API_KEY', models: null, spec: null });
  return found;
}

// Zero-config fallback: pick the first thing that works without asking.
export async function autoProviderSpec() {
  for (const f of await detectProviders()) {
    if (f.spec) return f.spec;
    if (f.models?.length) return f.prefix + f.models[0];
  }
  return null;
}
