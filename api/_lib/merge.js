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
  return { k: m.habitId + '|' + m.date, habitId: m.habitId, date: m.date, value, amount: amount(m.amount), updatedAt: num(m.updatedAt) };
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
