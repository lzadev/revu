// Parse `git diff` output into files → hunks → lines with real line numbers.
export function parseDiff(text) {
  const files = [];
  let f = null, h = null, oldNo = 0, newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { path: null, oldPath: null, status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(f); h = null;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) { f.oldPath = m[1]; f.path = m[2]; }
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith('new file mode')) f.status = 'added';
      else if (line.startsWith('deleted file mode')) f.status = 'deleted';
      else if (line.startsWith('rename to ')) { f.path = line.slice(10); f.status = 'renamed'; }
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.binary = true;
      else if (line.startsWith('+++ ')) {
        const p = line.slice(4).replace(/\t.*$/, '');
        if (p !== '/dev/null') f.path = p.startsWith('b/') ? p.slice(2) : p;
      }
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (!m) continue;
      h = { header: line, section: m[3].trim(), lines: [] };
      f.hunks.push(h); oldNo = +m[1]; newNo = +m[2];
      continue;
    }
    if (!h) continue;
    const c = line[0];
    if (c === '+') { h.lines.push({ type: 'add', newNo: newNo++, text: line.slice(1) }); f.additions++; }
    else if (c === '-') { h.lines.push({ type: 'del', oldNo: oldNo++, text: line.slice(1) }); f.deletions++; }
    else if (c === ' ') h.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  }
  return files.filter(x => x.path && !/[\u0000-\u001f\u007f]/.test(x.path));
}

// Render one file for the LLM with a NEW-file line-number gutter so it can cite exact lines.
// `redact` is applied to every line (secrets never leave the machine). Returns { text, truncated }.
export function renderFileForPrompt(file, maxChars = Infinity, redact = s => s) {
  const out = [`### FILE: ${file.path} (${file.status}, +${file.additions} -${file.deletions})`];
  let size = out[0].length;
  for (const h of file.hunks) {
    out.push(`@@ ${h.section}`.trimEnd());
    for (const l of h.lines) {
      const text = redact(l.text);
      const row = l.type === 'del' ? `     |- ${text}`
        : `${String(l.newNo).padStart(5)}|${l.type === 'add' ? '+' : ' '} ${text}`;
      size += row.length + 1;
      if (size > maxChars) { out.push('[... file truncated ...]'); return { text: out.join('\n'), truncated: true }; }
      out.push(row);
    }
  }
  return { text: out.join('\n'), truncated: false };
}
