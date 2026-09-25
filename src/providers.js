import { spawn } from 'node:child_process';
import os from 'node:os';
import { scanText } from './secrets.js';

const wait = s => AbortSignal.timeout(s * 1000);

const MAX_RESPONSE = 5 * 1024 * 1024;

async function post(url, headers, body, timeout) {
  // redirect:'error' → a server can't bounce our request (and its Authorization header) to another host
  const res = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: wait(timeout) });
  const text = await res.text();
  if (text.length > MAX_RESPONSE) throw new Error(`Response from ${url} is too large`);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`), { status: res.status });
  return JSON.parse(text);
}

const isLoopback = h => /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i.test(h);
const isPrivateLan = h => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h) || /\.local$/i.test(h);

// Never send code (or, worse, an API key) in clear text over the internet.
function assertSafeEndpoint(base, hasKey) {
  let u;
  try { u = new URL(base); } catch { throw new Error(`Invalid base_url: ${base}`); }
  if (u.protocol === 'https:') return;
  if (u.protocol !== 'http:') throw new Error(`Unsupported base_url protocol: ${u.protocol}`);
  const local = isLoopback(u.hostname) || (!hasKey && isPrivateLan(u.hostname));
  if (!local) throw new Error(`Refusing to send ${hasKey ? 'an API key and your code' : 'your code'} over plain http to ${u.hostname}. Use https (or localhost for local models).`);
}

// Any OpenAI-compatible server: Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, OpenAI, Groq…
async function openai(p, { system, user }, record) {
  const base = (p.base_url || 'http://localhost:11434/v1').replace(/\/$/, '');
  const key = p.api_key_env ? process.env[p.api_key_env] : undefined;
  assertSafeEndpoint(base, !!p.api_key_env);
  if (p.api_key_env && !key) throw new Error(`Env var ${p.api_key_env} is not set`);
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const body = { model: p.model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  let data;
  try { data = await post(`${base}/chat/completions`, headers, { ...body, response_format: { type: 'json_object' } }, p.timeout_s); }
  catch (e) { if (e.status !== 400) throw e; data = await post(`${base}/chat/completions`, headers, body, p.timeout_s); }
  record({ model: data.model || p.model, input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens });
  return data.choices[0].message.content;
}

// Ollama's NATIVE API. The OpenAI-compatible /v1 endpoint cannot set the context window per request, and Ollama's default
// window is small (4k tokens on machines with < 24 GB): a longer prompt is silently cut at the FRONT, dropping revu's
// instructions and your rules. Here num_ctx is sent with every request, JSON output is forced, and the answer is rejected
// if the prompt still filled the window.
async function ollama(p, { system, user }, record) {
  const base = (p.base_url || 'http://localhost:11434').replace(/\/$/, '');
  assertSafeEndpoint(base, false);
  const numCtx = p.num_ctx || 16384;
  const body = {
    model: p.model, stream: false, format: 'json',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    options: { temperature: 0, num_ctx: numCtx },
    ...(p.think !== undefined ? { think: p.think } : {}), // reasoning models (gpt-oss, qwen3…): true | false | 'low' | 'medium' | 'high'
  };
  let data;
  try { data = await post(`${base}/api/chat`, {}, body, p.timeout_s); }
  catch (e) { if (e.status === 404) throw new Error(`Ollama has no model "${p.model}". Run: ollama pull ${p.model}`); throw e; }
  const used = data.prompt_eval_count;
  if (Number.isFinite(used) && used >= numCtx * 0.9) {
    throw new Error(`The prompt (${used} tokens) filled Ollama's context window (${numCtx}), so the start of it — revu's instructions and your rules — may have been dropped. Raise provider.num_ctx or lower max_chars_per_request.`);
  }
  record({ model: data.model || p.model, input: data.prompt_eval_count, output: data.eval_count });
  return data.message?.content ?? '';
}

async function anthropic(p, { system, user }, record) {
  const key = process.env[p.api_key_env || 'ANTHROPIC_API_KEY'];
  if (!key) throw new Error(`Env var ${p.api_key_env || 'ANTHROPIC_API_KEY'} is not set`);
  const data = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    // No temperature/top_p/top_k: current Claude models reject sampling parameters with HTTP 400.
    // `effort` (low | medium | high | xhigh | max) is only sent when configured: older models reject it.
    { model: p.model || 'claude-sonnet-5', max_tokens: 8192, system, messages: [{ role: 'user', content: user }], ...(p.effort ? { output_config: { effort: p.effort } } : {}) }, p.timeout_s);
  const u = data.usage || {};
  record({ model: data.model || p.model, input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens });
  return data.content.map(c => c.text || '').join('');
}

// The child gets a minimal environment: an injected/agentic CLI must not see your GitHub, AWS, npm… tokens.
const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
const CLI_VARS = [[/^claude\b/, /^(ANTHROPIC_|CLAUDE_)/], [/^codex\b/, /^(OPENAI_|CODEX_)/], [/^gemini\b/, /^(GEMINI_|GOOGLE_)/]];
export function childEnv(p, env = process.env) {
  const exe = String(p.command).trim().split(/\s+/)[0].split('/').pop();
  const allow = [...CLI_VARS.filter(([re]) => re.test(exe)).map(([, v]) => v), ...[].concat(p.env || []).map(n => new RegExp('^' + String(n).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'))];
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SENSITIVE_NAME.test(k) || allow.some(re => re.test(k))));
}

// `claude -p --output-format json` wraps the answer: { type:'result', result, total_cost_usd, modelUsage:{model:{…}} }.
// Unwrap it and report which model answered and what it cost; anything else (plain-text CLIs) is passed through untouched.
function unwrapClaudeJson(out, record) {
  let d;
  try { d = JSON.parse(out); } catch { return out; }
  if (!d || d.type !== 'result' || typeof d.result !== 'string') return out;
  if (d.is_error) throw new Error(String(d.result).slice(0, 300) || 'the CLI reported an error');
  const usage = Object.entries(d.modelUsage || {});
  record({
    model: usage.map(([m]) => m).join('+') || undefined,
    input: usage.reduce((n, [, u]) => n + (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0), 0),
    output: usage.reduce((n, [, u]) => n + (u.outputTokens || 0), 0),
    cost: d.total_cost_usd, costBasis: usage[0]?.[1]?.costBasis,
  });
  return d.result;
}

// Shell out to a CLI that reads the prompt on stdin (claude -p, codex exec, gemini, llm, ollama run…)
function command(p, { system, user }, record) {
  return new Promise((resolve, reject) => {
    // cwd = tmpdir so an agentic CLI doesn't wander around the repo
    const child = spawn(p.command, { shell: true, cwd: os.tmpdir(), env: childEnv(p), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = fn => v => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject)(new Error(`Command timed out after ${p.timeout_s}s`)); }, p.timeout_s * 1000);
    child.stdout.on('data', d => { out += d; if (out.length > MAX_RESPONSE) { child.kill('SIGKILL'); finish(reject)(new Error('Command output is too large')); } });
    child.stderr.on('data', d => { if (err.length < 4000) err += d; });
    child.on('error', finish(reject));
    child.on('close', code => {
      if (code !== 0) {
        // a failing CLI may still print a JSON envelope with the human-readable reason
        let why = (err || out).trim();
        try { const d = JSON.parse(out); if (d && typeof d.result === 'string') why = d.result; } catch {}
        return finish(reject)(new Error(`\`${p.command.split(/\s+/).slice(0, 2).join(' ')} …\` exited with ${code}: ${why.slice(0, 400)}`));
      }
      try { finish(resolve)(unwrapClaudeJson(out, record)); } catch (e) { finish(reject)(e); } // must not throw inside an event handler
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${system}\n\n${user}`);
  });
}

export class SecretEgressError extends Error {
  constructor(msg) { super(msg); this.code = 'SECRET_EGRESS'; }
}

// THE egress gate. Every request to any provider goes through complete(), so this check cannot be skipped by a code path
// that forgot to redact ("if it is not always in the path, it is not a control"). If anything that still looks like a
// secret is in the outgoing text, nothing is sent. Values are never included in the message.
export function assertNoSecrets(cfg, prompt) {
  if (cfg?.secret_policy === 'off') return;
  const hits = scanText(`${prompt.system}\n${prompt.user}`);
  if (hits.length) {
    const kinds = [...new Set(hits.map(h => h.ruleId))].slice(0, 5).join(', ');
    throw new SecretEgressError(`Blocked before sending: the request still contained ${hits.length} secret-like value(s) (${kinds}). Nothing was sent to the LLM.`);
  }
}

// What the LLM calls of one review cost, as reported by the provider (model, tokens, and cost when it says so).
function addMeta(cfg, m = {}) {
  const t = (cfg._llmMeta ||= { calls: 0, models: [], input: 0, output: 0, cost: 0, costBasis: null });
  t.calls++;
  if (m.model && !t.models.includes(m.model)) t.models.push(m.model);
  t.input += Number.isFinite(m.input) ? m.input : 0;
  t.output += Number.isFinite(m.output) ? m.output : 0;
  if (Number.isFinite(m.cost)) { t.cost += m.cost; t.costBasis = m.costBasis || t.costBasis; }
}

export async function complete(cfg, prompt) {
  assertNoSecrets(cfg, prompt);
  cfg._onEgress?.(prompt); // local audit log (sizes only, never content)
  const p = { timeout_s: 300, ...cfg.provider };
  const record = m => addMeta(cfg, m);
  switch (p.type) {
    case 'openai': return openai(p, prompt, record);
    case 'ollama': return ollama(p, prompt, record);
    case 'anthropic': return anthropic(p, prompt, record);
    case 'command': return command(p, prompt, record);
    default: throw new Error(`Unknown provider type "${p.type}" (use openai | ollama | anthropic | command)`);
  }
}

export function extractJson(raw) {
  const s = raw.replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('No JSON object found in model output');
  return JSON.parse(s.slice(a, b + 1));
}

// ── Short provider specs: `provider: ollama:qwen2.5-coder:14b` instead of a 6-line block ─────────
export const CLI_PRESETS = {
  // --tools "" turns off the built-in tools only; MCP servers and skills would still be reachable (and cost ~35k tokens per call),
  // so they are switched off too. revu sends its whole prompt on stdin, so the default system prompt is replaced by a tiny one.
  claude: 'claude -p --output-format json --tools "" --no-session-persistence --strict-mcp-config --disable-slash-commands --system-prompt "You are a strict code reviewer. Follow the instructions in the user message exactly."',
  codex: 'codex exec --skip-git-repo-check --sandbox read-only -',
  gemini: 'gemini -p " "',
};
export const PROVIDER_SPECS = 'claude | claude:<model> | codex | gemini | ollama:<model> | lmstudio:<model> | openai:<model> | anthropic:<model> | openrouter:<model> | command:<your command>';

export function expandProvider(spec) {
  if (spec == null || typeof spec === 'object') return spec;
  const s = String(spec).trim();
  if (CLI_PRESETS[s]) return { type: 'command', command: CLI_PRESETS[s], timeout_s: 300 };
  const i = s.indexOf(':');
  const kind = i === -1 ? s : s.slice(0, i), arg = i === -1 ? '' : s.slice(i + 1).trim();
  const needModel = () => { if (!arg) throw new Error(`Provider "${s}" needs a model, e.g. ${kind}:<model>`); return arg; };
  switch (kind) {
    case 'claude': {
      if (!/^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$/.test(arg)) throw new Error(`Provider "${s}": invalid Claude model "${arg}" (use an alias such as sonnet / opus / haiku, or a model ID)`);
      return { type: 'command', command: CLI_PRESETS.claude.replace('claude -p ', `claude -p --model ${arg} `), timeout_s: 300 };
    }
    case 'ollama': return { type: 'ollama', base_url: 'http://localhost:11434', model: needModel(), num_ctx: 16384, timeout_s: 600 };
    case 'lmstudio': return { type: 'openai', base_url: 'http://localhost:1234/v1', model: needModel(), timeout_s: 600 };
    case 'openai': return { type: 'openai', base_url: 'https://api.openai.com/v1', model: arg || 'gpt-4.1', api_key_env: 'OPENAI_API_KEY' };
    case 'openrouter': return { type: 'openai', base_url: 'https://openrouter.ai/api/v1', model: needModel(), api_key_env: 'OPENROUTER_API_KEY' };
    case 'anthropic': return { type: 'anthropic', model: arg || 'claude-sonnet-5', api_key_env: 'ANTHROPIC_API_KEY' };
    case 'command': if (!arg) throw new Error('Provider "command:" needs a command, e.g. command:claude -p'); return { type: 'command', command: arg, timeout_s: 300 };
  }
  throw new Error(`Unknown provider "${s}". Use one of: ${PROVIDER_SPECS}`);
}
