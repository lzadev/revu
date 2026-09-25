// Translate a Go RE2 pattern (what gitleaks rules are written in) into an equivalent JavaScript pattern that behaves the
// same on EVERY Node version. JavaScript only got scoped flags — (?i:…) (?-i:…) — in newer engines, so instead of relying
// on them we expand case-insensitivity ourselves: a letter becomes [aA], a class [a-f] becomes [a-fA-F], and (?-i:…) zones
// are simply left as written. `.` becomes [^\n] (RE2 semantics), or [\s\S] inside (?s:…). Returns null when the pattern uses
// something we can't translate exactly (the caller then falls back to an approximation and reports it).

const HEX = /^[0-9a-fA-F]$/;

function readEscape(src, i) {
  const n = src[i + 1];
  if (n === undefined) return null;
  if (n === 'x') {
    if (HEX.test(src[i + 2] ?? '') && HEX.test(src[i + 3] ?? '')) return [src.slice(i, i + 4), 4];
    return null; // \x{10FFFF} etc. not supported
  }
  if (n === 'p' || n === 'P' || n === 'Q' || n === 'C') return null; // Unicode classes / literal quoting: not translated
  if (n === 'z') return ['(?![\\s\\S])', 2];
  if (n === 'A') return ['^', 2];
  return [src.slice(i, i + 2), 2];
}

const other = ch => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
const isLetter = ch => /^[A-Za-z]$/.test(ch);

// extra ranges that make a range case-insensitive
function foldRange(lo, hi) {
  const out = [];
  const a = [lo.charCodeAt(0), hi.charCodeAt(0)];
  const add = (from, to, delta) => { const s = Math.max(a[0], from), e = Math.min(a[1], to); if (s <= e) out.push(`${String.fromCharCode(s + delta)}-${String.fromCharCode(e + delta)}`); };
  add(97, 122, -32); // a-z → A-Z
  add(65, 90, 32);   // A-Z → a-z
  return out.join('');
}

function readClass(src, start, ci) {
  let i = start + 1, text = '[', extra = '';
  if (src[i] === '^') { text += '^'; i++; }
  if (src[i] === ']') { text += '\\]'; i++; } // a leading ] is a literal
  while (i < src.length && src[i] !== ']') {
    if (src[i] === '\\') {
      const e = readEscape(src, i);
      if (!e) return null;
      text += e[0].startsWith('\\') ? e[0] : e[0]; i += e[1];
      continue;
    }
    const c = src[i];
    if (src[i + 1] === '-' && src[i + 2] !== undefined && src[i + 2] !== ']' && src[i + 2] !== '\\') {
      const hi = src[i + 2];
      text += `${c}-${hi}`; if (ci) extra += foldRange(c, hi);
      i += 3; continue;
    }
    text += c === '[' ? '\\[' : c;
    if (ci && isLetter(c)) extra += other(c);
    i++;
  }
  if (src[i] !== ']') return null;
  return { text: text + extra + ']', end: i + 1 };
}

export function translate(src) {
  const stack = [{ i: false, s: false }];
  const top = () => stack[stack.length - 1];
  let out = '', p = 0;
  while (p < src.length) {
    const c = src[p];
    if (c === '\\') { const e = readEscape(src, p); if (!e) return null; out += e[0]; p += e[1]; continue; }
    if (c === '[') { const r = readClass(src, p, top().i); if (!r) return null; out += r.text; p = r.end; continue; }
    if (c === '(') {
      if (src[p + 1] === '?') {
        const rest = src.slice(p);
        const f = /^\(\?([imsU]*)(?:-([imsU]*))?([:)])/.exec(rest);
        if (f && (f[1] || f[2] !== undefined || f[3] === ':')) {
          const on = f[1] || '', off = f[2] || '';
          if (/[mU]/.test(on + off)) return null; // multi-line / ungreedy modes: not translated
          const flags = { ...top() };
          for (const ch of on) flags[ch] = true;
          for (const ch of off) flags[ch] = false;
          if (f[3] === ')') stack[stack.length - 1] = flags;      // (?i)  → applies to the rest of the current group
          else { stack.push(flags); out += '(?:'; }               // (?i:…) → scoped
          p += f[0].length; continue;
        }
        if (rest.startsWith('(?P<')) { out += '(?<'; p += 4; stack.push({ ...top() }); continue; }
        const g = /^\(\?(?::|<[A-Za-z_]\w*>|=|!|<=|<!)/.exec(rest);
        if (!g) return null;
        out += g[0]; p += g[0].length; stack.push({ ...top() }); continue;
      }
      out += '('; p++; stack.push({ ...top() }); continue;
    }
    if (c === ')') { out += ')'; p++; if (stack.length > 1) stack.pop(); continue; }
    if (c === '.') { out += top().s ? '[\\s\\S]' : '[^\\n]'; p++; continue; }
    if (top().i && isLetter(c)) { out += `[${c.toLowerCase()}${c.toUpperCase()}]`; p++; continue; }
    out += c; p++;
  }
  return out;
}
