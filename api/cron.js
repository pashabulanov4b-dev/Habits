import webpush from 'web-push';
import { redis, keys, noDb } from './_lib/redis.js';
import { parse } from './_lib/merge.js';
import { isDue, buildMessage, localParts, dueTasks, taskMessage } from './_lib/reminder.js';

// Викликається за розкладом (GitHub Actions кожні ~15 хв) з заголовком Authorization: Bearer CRON_SECRET.
// Надсилає: щоденне нагадування про звички + нагадування про завдання з дзвіночком.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  if (!redis) return noDb(res);
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return res.status(500).json({ error: 'VAPID keys missing' });

  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const now = Date.now();
  const users = (await redis.smembers(keys.pushUsers)) || [];
  let sent = 0;

  for (const uid of users) {
    const cfg = parse(await redis.get(keys.push(uid)));
    if (!cfg || !cfg.subs || !cfg.subs.length) continue;
    const local = localParts(now, cfg.tz);
    const msgs = [];
    const next = { ...cfg };

    // 1) щоденне про звички
    if (isDue(cfg, now).due) {
      const [habitsAll, marksAll] = await Promise.all([redis.hgetall(keys.habits(uid)), redis.hgetall(keys.marks(uid))]);
      const msg = buildMessage(habitsAll, marksAll, local.date);
      if (msg) msgs.push(msg);
      next.lastSent = local.date;
    }

    // 2) завдання з дзвіночком
    const sentTasks = Object.fromEntries(Object.entries(cfg.taskSent || {}).filter(([, v]) => String(v).startsWith(local.date)));
    const tasks = dueTasks(await redis.hgetall(keys.tasks(uid)), local, sentTasks);
    tasks.forEach((t) => { msgs.push(taskMessage(t)); sentTasks[t.id] = t.date + ' ' + t.time; });
    next.taskSent = sentTasks;

    if (!msgs.length && next.lastSent === cfg.lastSent) continue;

    let alive = cfg.subs;
    for (const msg of msgs) {
      const still = [];
      for (const sub of alive) {
        try {
          await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 2 * 3600, urgency: 'high' });
          still.push(sub);
          sent++;
        } catch (e) {
          if (e.statusCode !== 404 && e.statusCode !== 410) still.push(sub); // 404/410 = підписка більше не діє
        }
      }
      alive = still;
    }
    next.subs = alive;
    next.enabled = alive.length > 0;
    await redis.set(keys.push(uid), JSON.stringify(next));
    if (!alive.length) await redis.srem(keys.pushUsers, uid);
  }
  res.status(200).json({ ok: true, users: users.length, sent });
}
