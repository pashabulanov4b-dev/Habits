// Синхронізація: усе спершу пишеться на телефон (dirty: true),
// а коли є інтернет — відправляється на сервер і підтягуються зміни з інших пристроїв.
import { db } from './db.js';

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

// Підключити цей телефон до вже існуючого акаунта (код з іншого пристрою).
export async function adoptUserId(code) {
  const clean = String(code || '').trim();
  if (!/^u-[a-f0-9]{32}$/.test(clean)) throw new Error('Невірний код');
  await db.setMeta('userId', clean);
  await db.setMeta('since', 0);
  // Усе, що вже є на телефоні, відправиться в новий акаунт.
  const [habits, marks] = await Promise.all([db.getAll('habits'), db.getAll('marks')]);
  await db.putMany('habits', habits.map((h) => ({ ...h, dirty: true })));
  await db.putMany('marks', marks.map((m) => ({ ...m, dirty: true })));
}

export async function countPending() {
  const [habits, marks] = await Promise.all([db.getAll('habits'), db.getAll('marks')]);
  return habits.filter((h) => h.dirty).length + marks.filter((m) => m.dirty).length;
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
      const [habits, marks] = await Promise.all([db.getAll('habits'), db.getAll('marks')]);
      const dirtyHabits = habits.filter((h) => h.dirty).map(strip);
      const dirtyMarks = marks.filter((m) => m.dirty).map(strip);

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, since, habits: dirtyHabits, marks: dirtyMarks })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      // Перечитуємо локальні записи: поки йшов запит, користувач міг щось змінити.
      const [lh, lm] = await Promise.all([db.getAll('habits'), db.getAll('marks')]);
      const localH = new Map(lh.map((h) => [h.id, h]));
      const localM = new Map(lm.map((m) => [m.k, m]));
      const putH = [];
      const putM = [];
      let changed = false;

      const mergeInto = (local, server, out) => {
        if (!local || server.updatedAt > local.updatedAt) {
          out.push({ ...server, dirty: false });
          changed = true;
        } else if (local.dirty && server.updatedAt === local.updatedAt) {
          out.push({ ...local, dirty: false }); // сервер прийняв нашу зміну
        }
      };
      (data.habits || []).forEach((h) => mergeInto(localH.get(h.id), h, putH));
      (data.marks || []).forEach((m) => mergeInto(localM.get(m.k), m, putM));

      // Записи, які ми відправили, але сервер має новішу або таку саму версію — вже не "брудні".
      const sentH = new Set(dirtyHabits.map((h) => h.id + '@' + h.updatedAt));
      const sentM = new Set(dirtyMarks.map((m) => m.k + '@' + m.updatedAt));
      lh.forEach((h) => { if (h.dirty && sentH.has(h.id + '@' + h.updatedAt) && !putH.some((x) => x.id === h.id)) putH.push({ ...h, dirty: false }); });
      lm.forEach((m) => { if (m.dirty && sentM.has(m.k + '@' + m.updatedAt) && !putM.some((x) => x.k === m.k)) putM.push({ ...m, dirty: false }); });

      await db.putMany('habits', putH);
      await db.putMany('marks', putM);
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
