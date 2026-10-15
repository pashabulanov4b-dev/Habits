// Локальний сервер для перевірки без Vercel: роздає public/ і імітує /api/sync у пам'яті.
// Запуск: node scripts/dev-server.mjs  →  http://localhost:5173
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_RE, cleanHabit, cleanMark, cleanTask, cleanJournal, cleanSleep, mergeRecords, changedSince } from '../api/_lib/merge.js';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const store = new Map(); // key -> {field: json}

const hgetall = (k) => store.get(k) || {};
const hset = (k, obj) => store.set(k, { ...hgetall(k), ...obj });

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const b = await body(req);
    if (!USER_RE.test(b.userId || '')) { res.writeHead(400); return res.end('bad'); }
    const now = Date.now();
    const s = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)]));
    const out = { serverTime: now };
    for (const [name, suffix, clean, idOf] of [['habits', 'h', cleanHabit, (r) => r.id], ['marks', 'm', cleanMark, (r) => r.k], ['tasks', 't', cleanTask, (r) => r.id], ['journal', 'j', cleanJournal, (r) => r.id], ['sleep', 's', cleanSleep, (r) => r.id]]) {
      const key = `u:${b.userId}:${suffix}`;
      hset(key, s(mergeRecords(hgetall(key), (b[name] || []).map(clean).filter(Boolean), idOf, now)));
      out[name] = changedSince(hgetall(key), b.since || 0);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }
  if (url.pathname === '/api/_debug') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.fromEntries(store)));
  }
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ vapidPublicKey: null }));
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': TYPES['.html'] });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
