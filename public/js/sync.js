// Синхронізація: усе спершу пишеться на телефон (dirty: true),
// а коли є інтернет — відправляється на сервер і підтягуються зміни з інших пристроїв.
import { db } from './db.js';

// Що синхронізуємо: назва сховища → поле-ключ запису
const STORES = [['habits', 'id'], ['marks', 'k'], ['tasks', 'id'], ['journal', 'id'], ['sleep', 'id']];

const listeners = new Set();
let status = { state: 'idle', lastSync: null, pending: 0 };
let running = null;
let again = false;
let timer = null;

export function onSyncStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); }
function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

export async function getUserId() {
  let id = await db.getMeta('userId');
  if (!id) {
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    id = 'u-' + Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
    await db.setMeta('userId', id);
  }
  return id;
}

const readAll = () => Promise.all(STORES.map(([s]) => db.getAll(s)));

// Підключити цей телефон до вже існуючого акаунта (код з іншого пристрою).
export async function adoptUserId(code) {
  const clean = String(code || '').trim();
  if (!/^u-[a-f0-9]{32}$/.test(clean)) throw new Error('Невірний код');
  await db.setMeta('userId', clean);
  await db.setMeta('since', 0);
  // Усе, що вже є на телефоні, відправиться в новий акаунт.
  const all = await readAll();
  await Promise.all(STORES.map(([s], i) => db.putMany(s, all[i].map((r) => ({ ...r, dirty: true })))));
}

export async function countPending() {
  const all = await readAll();
  return all.reduce((n, list) => n + list.filter((r) => r.dirty).length, 0);
}

export function scheduleSync(delay = 800) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), delay);
}

const strip = ({ dirty, ...rest }) => rest;

export async function syncNow({ onMerged } = {}) {
  if (running) { again = true; return running; }
  running = (async () => {
    const pending = await countPending();
    if (!navigator.onLine) {
      setStatus({ state: 'offline', pending });
      return;
    }
    setStatus({ state: 'syncing', pending });
    try {
      const userId = await getUserId();
      const since = await db.getMeta('since', 0);
      const before = await readAll();
      const body = { userId, since };
      const sent = {};
      STORES.forEach(([s, key], i) => {
        body[s] = before[i].filter((r) => r.dirty).map(strip);
        sent[s] = new Set(body[s].map((r) => r[key] + '@' + r.updatedAt));
      });

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      // Перечитуємо локальні записи: поки йшов запит, користувач міг щось змінити.
      const after = await readAll();
      let changed = false;
      for (let i = 0; i < STORES.length; i++) {
        const [s, key] = STORES[i];
        const local = new Map(after[i].map((r) => [r[key], r]));
        const out = new Map();
        (data[s] || []).forEach((srv) => {
          const loc = local.get(srv[key]);
          if (!loc || srv.updatedAt > loc.updatedAt) {
            out.set(srv[key], { ...srv, dirty: false });
            changed = true;
          } else if (loc.dirty && srv.updatedAt === loc.updatedAt) {
            out.set(srv[key], { ...loc, dirty: false }); // сервер прийняв нашу зміну
          }
        });
        // Відправлене й не змінене з того часу — вже не «брудне»
        after[i].forEach((r) => {
          if (r.dirty && sent[s].has(r[key] + '@' + r.updatedAt) && !out.has(r[key])) out.set(r[key], { ...r, dirty: false });
        });
        await db.putMany(s, [...out.values()]);
      }

      await db.setMeta('since', Math.max(0, (data.serverTime || 0) - 5000));
      const lastSync = Date.now();
      await db.setMeta('lastSync', lastSync);
      setStatus({ state: 'synced', lastSync, pending: await countPending() });
      const cb = onMerged || mergedCb;
      if (changed && cb) cb();
    } catch (e) {
      setStatus({ state: navigator.onLine ? 'error' : 'offline', pending: await countPending() });
    }
  })();
  try { await running; } finally {
    running = null;
    if (again) { again = false; scheduleSync(300); }
  }
}

let mergedCb = null;
export async function initSync(onMerged) {
  mergedCb = onMerged;
  setStatus({ lastSync: await db.getMeta('lastSync', null) });
  const run = () => syncNow({ onMerged });
  window.addEventListener('online', run);
  window.addEventListener('offline', () => countPending().then((pending) => setStatus({ state: 'offline', pending })));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
  setInterval(() => { if (document.visibilityState === 'visible') run(); }, 60000);
  run();
  return run;
}
