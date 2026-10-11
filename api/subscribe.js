import { redis, keys, noDb } from './_lib/redis.js';
import { USER_RE, parse } from './_lib/merge.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!redis) return noDb(res);
  const { userId, subscription, time, tz, enabled } = req.body || {};
  if (!USER_RE.test(userId || '')) return res.status(400).json({ error: 'bad userId' });
  const endpoint = subscription && typeof subscription.endpoint === 'string' ? subscription.endpoint : null;
  if (!endpoint || !/^https:\/\//.test(endpoint)) return res.status(400).json({ error: 'bad subscription' });

  const key = keys.push(userId);
  const cur = parse(await redis.get(key)) || { subs: [], time: '20:00', tz: 'UTC', enabled: false, lastSent: null };
  let subs = (cur.subs || []).filter((s) => s.endpoint !== endpoint);
  if (enabled) {
    subs.push({ endpoint, keys: { p256dh: String(subscription.keys?.p256dh || ''), auth: String(subscription.keys?.auth || '') } });
    subs = subs.slice(-5); // максимум 5 пристроїв
  }
  const next = {
    ...cur,
    subs,
    enabled: subs.length > 0,
    time: /^\d{2}:\d{2}$/.test(time || '') ? time : cur.time,
    tz: typeof tz === 'string' && tz.length < 64 ? tz : cur.tz
  };
  // Новий час — нагадування сьогодні ще може прийти.
  if (time && time !== cur.time) next.lastSent = null;

  await redis.set(key, JSON.stringify(next));
  if (next.enabled) await redis.sadd(keys.pushUsers, userId);
  else await redis.srem(keys.pushUsers, userId);
  res.status(200).json({ ok: true, enabled: next.enabled });
}
