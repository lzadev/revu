// Fake OpenAI-compatible server: "reviews" by pattern matching, so tests are deterministic and free.
import http from 'node:http';

export function startMock(port = 0) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const user = JSON.parse(body).messages.at(-1).content;
      const findings = [];
      let file = null;
      for (const line of user.split('\n')) {
        const fm = line.match(/^### FILE: (\S+)/);
        if (fm) { file = fm[1]; continue; }
        const m = line.match(/^\s*(\d+)\|\+ (.*)$/);
        if (!m || !file) continue;
        const [, no, text] = m;
        if (/console\.log/.test(text)) findings.push({ severity: 'major', category: 'convention', file, line: +no, end_line: +no, title: 'Remove console.log', explanation: 'Team rule: no `console.log` in production code.', suggestion_code: null, rule: 'no-console' });
        if (/apiKey\s*=\s*"/.test(text)) findings.push({ severity: 'critical', category: 'security', file, line: +no, end_line: +no, title: 'Hardcoded API key', explanation: 'Secrets committed to git leak forever. Read it from the environment instead.', suggestion_code: text.replace(/"[^"]*"/, 'process.env.API_KEY'), rule: 'no-secrets' });
        if (/TODO/.test(text)) findings.push({ severity: 'nit', category: 'style', file, line: +no, end_line: +no, title: 'TODO left behind', explanation: 'Track it in an issue.', suggestion_code: null, rule: null });
      }
      findings.push({ severity: 'major', category: 'bug', file: 'ghost.js', line: 3, title: 'Hallucinated file', explanation: 'x' }); // must be dropped
      const content = JSON.stringify({ summary: 'Adds a small service module.', walkthrough: [{ file: file || 'x', change: 'Adds `fetchUser` helper' }], findings });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startMock(Number(process.env.PORT || 11500));
  console.log('mock on', s.address().port);
}
