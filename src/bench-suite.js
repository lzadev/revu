// `revu bench` suite: seven planted bugs across four files plus two clean files, so a model is scored on what it finds AND on what it
// wrongly reports. Synthetic on purpose: it never touches your code. Each bug is located by a unique substring, so line numbers are
// computed, not typed. Bump BENCH_VERSION whenever the files, the bugs or the guidelines change (scores are only comparable within a version).
export const BENCH_VERSION = 1;

// The same team rules for every run, so results do not depend on the repository you run it in.
export const BENCH_GUIDELINES = `- MUST: every promise / async call handles its error (try/catch or .catch); no swallowed errors.
- MUST: never commit secrets, tokens or private URLs; read them from environment variables.
- Descriptive names, no cryptic abbreviations.
- Any change to business logic should come with a test.`;

// What was measured with this suite on 2026-09 (one run each, temperature default / 0): a yardstick, not a ranking.
export const REFERENCE = [
  { model: 'claude-sonnet-5 (claude -p)', found: 7, total: 7, note: '~27 s' },
  { model: 'qwen2.5-coder:14b (Ollama, Apple M3 Pro 18 GB)', found: 2, total: 7, note: '~54 s' },
];
export const FILES = {
  'src/orders.js': `export async function loadOrders(userId) {
  const res = await fetch(\`/api/orders?user=\${encodeURIComponent(userId)}\`);
  if (!res.ok) throw new Error(\`Failed to load orders: \${res.status}\`);
  const data = res.json();
  return data.orders.map(order => ({ id: order.id, total: order.total }));
}

export function lastNOrders(orders, n) {
  const result = [];
  for (let i = orders.length - n; i <= orders.length; i++) {
    result.push(orders[i]);
  }
  return result;
}
`,
  'src/auth.js': `import { db } from './db.js';

export async function findUser(req, res) {
  const rows = await db.query('SELECT id, email FROM users WHERE id = ' + req.params.id);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  return res.json(rows[0]);
}

export function newSessionToken() {
  return Math.random().toString(36).slice(2);
}
`,
  'src/cart.js': `export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity);
}

export function applyDiscount(total, percent) {
  return total - total * (percent / 100);
}

export function removeItem(items, id) {
  const index = items.findIndex(item => item.id === id);
  items.splice(index, 1);
  return items;
}
`,
  'src/jobs.js': `export function scheduleCleanup(store) {
  setInterval(async () => {
    await store.deleteExpired();
  }, 60_000);
}

export function parseConfig(text) {
  return JSON.parse(text);
}
`,
  'src/clean1.js': `export function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function chunk(list, size) {
  if (size <= 0) throw new RangeError('size must be positive');
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}
`,
  'src/clean2.js': `export async function fetchJson(url, { signal } = {}) {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);
    return await res.json();
  } catch (error) {
    throw new Error(\`fetchJson(\${url}) failed: \${error.message}\`, { cause: error });
  }
}

export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
`,
};

export const PLANTED = [
  { id: 'A1 missing await on res.json()', file: 'src/orders.js', at: 'const data = res.json();' },
  { id: 'A2 off-by-one (<= length)', file: 'src/orders.js', at: 'i <= orders.length' },
  { id: 'B1 SQL injection', file: 'src/auth.js', at: "'SELECT id, email FROM users WHERE id = ' + req.params.id" },
  { id: 'B2 Math.random for a session token', file: 'src/auth.js', at: 'Math.random().toString(36)' },
  { id: 'C1 reduce without initial value', file: 'src/cart.js', at: 'items.reduce((sum, item)' },
  { id: 'C2 splice(-1) when not found', file: 'src/cart.js', at: 'items.splice(index, 1)' },
  { id: 'D1 async interval callback without error handling', file: 'src/jobs.js', at: 'await store.deleteExpired()' },
].map(b => ({ ...b, line: FILES[b.file].split('\n').findIndex(l => l.includes(b.at)) + 1 }));
