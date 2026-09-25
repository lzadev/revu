// Minimal glob -> RegExp: supports **, *, ?, {a,b}
const NEVER = /(?!)/;
const cache = new Map();

// Patterns come from config (i.e. from the repo): collapse `**/**/**` and cap wildcards so they can't cause ReDoS.
export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  const re = compile(String(glob).slice(0, 300).replace(/(\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**'));
  cache.set(glob, re);
  return re;
}

function compile(glob) {
  if ((glob.match(/\*/g) || []).length > 8) return NEVER;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export const matchesAny = (file, globs) => globs.some(g => globToRegExp(g).test(file));
