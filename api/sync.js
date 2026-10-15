import { redis, keys, noDb } from './_lib/redis.js';
import { USER_RE, cleanHabit, cleanMark, cleanTask, cleanJournal, cleanSleep, mergeRecords, changedSince } from './_lib/merge.js';

const MAX_ITEMS = 5000;

// Що синхронізуємо: поле в запиті → [ключ Redis, очищення, ключ запису]
const KINDS = {
  habits: [keys.habits, cleanHabit, (r) => r.id],
  marks: [keys.marks, cleanMark, (r) => r.k],
  tasks: [keys.tasks, cleanTask, (r) => r.id],
  journal: [keys.journal, cleanJournal, (r) => r.id],
  sleep: [keys.sleep, cleanSleep, (r) => r.id]
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!redis) return noDb(res);

  const body = req.body || {};
  const userId = body.userId;
  if (!USER_RE.test(userId || '')) return res.status(400).json({ error: 'bad userId' });
  const since = Number.isFinite(body.since) ? body.since : 0;
  const now = Date.now();

  const names = Object.keys(KINDS);
  const existing = await Promise.all(names.map((n) => redis.hgetall(KINDS[n][0](userId))));
  const out = { serverTime: now };
  const ops = [];
  names.forEach((n, i) => {
    const [keyOf, clean, idOf] = KINDS[n];
    const incoming = (Array.isArray(body[n]) ? body[n] : []).slice(0, MAX_ITEMS).map(clean).filter(Boolean);
    const writes = mergeRecords(existing[i] || {}, incoming, idOf, now);
    if (Object.keys(writes).length) ops.push(redis.hset(keyOf(userId), stringify(writes)));
    out[n] = changedSince({ ...(existing[i] || {}), ...writes }, since);
  });
  await Promise.all(ops);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(out);
}

function stringify(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = JSON.stringify(obj[k]);
  return out;
}
