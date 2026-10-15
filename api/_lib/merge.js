// Чиста логіка злиття (без мережі) — легко тестувати.
// Правило: перемагає запис з новішим updatedAt (last-write-wins).

export const USER_RE = /^u-[a-f0-9]{32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^h-[a-z0-9]{4,40}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) ? v : 0);
// кількість (сторінок, хвилин…): невід'ємне число з одним знаком після коми, або null
const amount = (v) => (Number.isFinite(v) && v >= 0 && v < 1e6 ? Math.round(v * 10) / 10 : null);

export function cleanHabit(h) {
  if (!h || !ID_RE.test(h.id)) return null;
  return {
    id: h.id,
    name: str(h.name, 60),
    full: str(h.full, 60),
    min: str(h.min, 60),
    kind: h.kind === 'count' ? 'count' : 'check',
    target: amount(h.target),
    minAmount: amount(h.minAmount),
    unit: str(h.unit, 20),
    note: str(h.note, 300),
    askNote: !!h.askNote,
    sleep: /^[a-z]{1,12}$/.test(h.sleep || '') ? h.sleep : '',
    perWeek: Number.isInteger(h.perWeek) && h.perWeek >= 1 && h.perWeek <= 7 ? h.perWeek : 7,
    order: num(h.order),
    start: DATE_RE.test(h.start) ? h.start : '1970-01-01',
    createdAt: num(h.createdAt),
    updatedAt: num(h.updatedAt),
    deleted: !!h.deleted
  };
}

export function cleanMark(m) {
  if (!m || !ID_RE.test(m.habitId) || !DATE_RE.test(m.date)) return null;
  const value = [0, 1, 2].includes(m.value) ? m.value : 0;
  return { k: m.habitId + '|' + m.date, habitId: m.habitId, date: m.date, value, amount: amount(m.amount), note: str(m.note, 500), jAt: num(m.jAt), updatedAt: num(m.updatedAt) };
}

const TASK_RE = /^t-[a-z0-9]{4,40}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Завдання планувальника
export function cleanTask(t) {
  if (!t || !TASK_RE.test(t.id) || !DATE_RE.test(t.date)) return null;
  const time = TIME_RE.test(t.time || '') ? t.time : '';
  const endTime = time && TIME_RE.test(t.endTime || '') && t.endTime > time ? t.endTime : '';
  // точний час нагадування; старі версії слали лише remind + time → за 15 хв до початку
  let remindAt = TIME_RE.test(t.remindAt || '') ? t.remindAt : '';
  if (!remindAt && t.remind && time) {
    const m = Math.max(0, Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) - 15);
    remindAt = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  return {
    id: t.id,
    title: str(t.title, 120),
    date: t.date,
    time,
    endTime,
    remind: !!t.remind && !!remindAt,
    remindAt: t.remind ? remindAt : '',
    done: !!t.done,
    note: str(t.note, 500),
    askNote: !!t.askNote,
    important: !!t.important,
    doneNote: str(t.doneNote, 500),
    jAt: num(t.jAt), // >0 — нотатка «як пройшло» додана в щоденник
    order: num(t.order),
    createdAt: num(t.createdAt),
    updatedAt: num(t.updatedAt),
    deleted: !!t.deleted
  };
}

const JOURNAL_RE = /^j-[a-z0-9]{4,40}$/;

// Власний запис у щоденнику
export function cleanJournal(j) {
  if (!j || !JOURNAL_RE.test(j.id) || !DATE_RE.test(j.date)) return null;
  return {
    id: j.id,
    date: j.date,
    text: str(j.text, 3000),
    createdAt: num(j.createdAt),
    updatedAt: num(j.updatedAt),
    deleted: !!j.deleted
  };
}

// «Режим сну»: налаштування (s-cfg), дні (s-d-YYYY-MM-DD) і «Нічні ідеї» (s-i-…)
const SLEEP_RE = /^s-(cfg|d-\d{4}-\d{2}-\d{2}|i-[a-z0-9]{4,40})$/;
const SLEEP_NOTIFS = ['wake', 'light', 'coffee', 'dim', 'ideas', 'bed'];
const tm = (v) => (TIME_RE.test(v || '') ? v : '');
export function cleanSleep(r) {
  if (!r || !SLEEP_RE.test(r.id)) return null;
  const base = { id: r.id, updatedAt: num(r.updatedAt), deleted: !!r.deleted };
  if (r.id === 's-cfg') {
    const notif = {};
    for (const k of SLEEP_NOTIFS) notif[k] = !(r.notif && r.notif[k] === false);
    return { ...base, kind: 'cfg', active: !!r.active, start: DATE_RE.test(r.start) ? r.start : '',
      curBed: tm(r.curBed), curWake: tm(r.curWake), tgtBed: tm(r.tgtBed), tgtWake: tm(r.tgtWake),
      repeats: Number.isInteger(r.repeats) && r.repeats >= 0 && r.repeats < 50 ? r.repeats : 0,
      notif, melatonin: !!r.melatonin };
  }
  if (r.id.startsWith('s-d-')) {
    const date = r.id.slice(4);
    return { ...base, kind: 'day', date, bed: tm(r.bed), wake: tm(r.wake), shift: tm(r.shift) };
  }
  return { ...base, kind: 'idea', date: DATE_RE.test(r.date) ? r.date : '1970-01-01', text: str(r.text, 1000), createdAt: num(r.createdAt) };
}

export const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * existing: { key: record }  incoming: [record]  keyOf: rec => key
 * Повертає { writes: { key: record } } — тільки те, що треба записати.
 */
export function mergeRecords(existing, incoming, keyOf, now) {
  const writes = {};
  for (const rec of incoming) {
    const key = keyOf(rec);
    const ex = existing[key] ? parse(existing[key]) : null;
    if (!ex || rec.updatedAt > ex.updatedAt) {
      writes[key] = { ...rec, sv: now };
    }
  }
  return writes;
}

/** Записи, змінені на сервері після since (sv = серверний час запису). */
export function changedSince(all, since) {
  const out = [];
  for (const key of Object.keys(all || {})) {
    const rec = parse(all[key]);
    if ((rec.sv || 0) > since) {
      const { sv, ...rest } = rec;
      out.push(rest);
    }
  }
  return out;
}
