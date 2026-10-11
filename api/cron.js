import webpush from 'web-push';
import { redis, keys, noDb } from './_lib/redis.js';
import { parse } from './_lib/merge.js';
import { isDue, buildMessage } from './_lib/reminder.js';

// Викликається за розкладом (GitHub Actions кожні ~15 хв) з заголовком Authorization: Bearer CRON_SECRET.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  if (!redis) return noDb(res);
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(500).json({ error: 'VAPID keys missing' });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const now = Date.now();
  const users = (await redis.smembers(keys.pushUsers)) || [];
  let sent = 0, checked = 0;

  for (const uid of users) {
    const cfg = parse(await redis.get(keys.push(uid)));
    const { due, local } = isDue(cfg, now);
    if (!due) continue;
    checked++;
    const [habitsAll, marksAll] = await Promise.all([redis.hgetall(keys.habits(uid)), redis.hgetall(keys.marks(uid))]);
    const msg = buildMessage(habitsAll, marksAll, local.date);
    const alive = [];
    if (msg) {
      for (const sub of cfg.subs) {
        try {
          await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 3 * 3600, urgency: 'normal' });
          alive.push(sub);
          sent++;
        } catch (e) {
          if (e.statusCode !== 404 && e.statusCode !== 410) alive.push(sub); // 404/410 = підписка більше не діє
        }
      }
    } else {
      alive.push(...cfg.subs);
    }
    const next = { ...cfg, subs: alive, enabled: alive.length > 0, lastSent: local.date };
    await redis.set(keys.push(uid), JSON.stringify(next));
    if (!alive.length) await redis.srem(keys.pushUsers, uid);
  }
  res.status(200).json({ ok: true, users: users.length, checked, sent });
}
