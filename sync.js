import { redis, keys, noDb } from './_lib/redis.js';
import { USER_RE, cleanHabit, cleanMark, mergeRecords, changedSince } from './_lib/merge.js';

const MAX_ITEMS = 5000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!redis) return noDb(res);

  const body = req.body || {};
  const userId = body.userId;
  if (!USER_RE.test(userId || '')) return res.status(400).json({ error: 'bad userId' });
  const since = Number.isFinite(body.since) ? body.since : 0;
  const habitsIn = (Array.isArray(body.habits) ? body.habits : []).slice(0, MAX_ITEMS).map(cleanHabit).filter(Boolean);
  const marksIn = (Array.isArray(body.marks) ? body.marks : []).slice(0, MAX_ITEMS).map(cleanMark).filter(Boolean);

  const now = Date.now();
  const [habitsAll, marksAll] = await Promise.all([
    redis.hgetall(keys.habits(userId)),
    redis.hgetall(keys.marks(userId))
  ]);

  const hWrites = mergeRecords(habitsAll || {}, habitsIn, (h) => h.id, now);
  const mWrites = mergeRecords(marksAll || {}, marksIn, (m) => m.k, now);

  const ops = [];
  if (Object.keys(hWrites).length) ops.push(redis.hset(keys.habits(userId), stringify(hWrites)));
  if (Object.keys(mWrites).length) ops.push(redis.hset(keys.marks(userId), stringify(mWrites)));
  await Promise.all(ops);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    serverTime: now,
    habits: changedSince({ ...(habitsAll || {}), ...hWrites }, since),
    marks: changedSince({ ...(marksAll || {}), ...mWrites }, since)
  });
}

function stringify(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = JSON.stringify(obj[k]);
  return out;
}
