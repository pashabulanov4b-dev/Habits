// Логіка нагадувань без мережі — легко тестувати.
import { parse } from './merge.js';

export function localParts(now, tz) {
  let zone = tz;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: zone }); } catch (e) { zone = 'UTC'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const shift = (date, days) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 20 * 60;
};

// Розклад запускається що ~15 хв і може запізнюватися, тому вікно — 3 години після заданого часу.
export function isDue(cfg, now) {
  if (!cfg || !cfg.enabled || !cfg.subs || !cfg.subs.length) return { due: false };
  if (cfg.daily === false) return { due: false, local: localParts(now, cfg.tz) };
  const local = localParts(now, cfg.tz);
  const diff = local.minutes - toMin(cfg.time);
  if (cfg.lastSent === local.date) return { due: false, local };
  return { due: diff >= 0 && diff < 180, local };
}

/**
 * Нагадування про завдання планувальника: за 15 хв до часу (розклад іде раз на ~15 хв,
 * тому вікно — від −20 до +90 хв, щоб не пропустити через затримку).
 * sent — { taskId: 'YYYY-MM-DD' }, щоб не надсилати двічі.
 */
export function dueTasks(tasksAll, local, sent = {}) {
  return Object.values(tasksAll || {}).map(parse).filter((t) => {
    if (!t || t.deleted || t.done || !t.remind || t.date !== local.date) return false;
    if (!/^\d{2}:\d{2}$/.test(t.time || '') || sent[t.id] === t.date + ' ' + t.time) return false;
    const diff = local.minutes - toMin(t.time);
    return diff >= -20 && diff <= 90;
  }).sort((a, b) => (a.time < b.time ? -1 : 1));
}

export function taskMessage(t) {
  return {
    title: `${t.time} · ${t.title}`,
    body: 'Нагадування з плану на сьогодні',
    tag: 'task-' + t.id,
    url: '/?tab=plan'
  };
}

export function buildMessage(habitsAll, marksAll, date) {
  const habits = Object.values(habitsAll || {}).map(parse).filter((h) => !h.deleted && h.start <= date);
  if (!habits.length) return null;
  const done = (h, d) => { const m = marksAll && marksAll[h.id + '|' + d]; return !!(m && parse(m).value > 0); };
  const left = habits.filter((h) => {
    if (done(h, date)) return false;
    const pw = h.perWeek >= 1 && h.perWeek <= 6 ? h.perWeek : 7;
    if (pw === 7) return true;
    // Тижнева звичка: нагадуємо, лише якщо без сьогоднішнього дня ціль тижня вже не встигнути
    const dow = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0 = понеділок
    const ws = shift(date, -dow);
    let count = 0;
    for (let i = 0; i < dow; i++) { const d = shift(ws, i); if (d >= h.start && done(h, d)) count++; }
    const from = h.start > ws ? h.start : ws;
    const avail = 7 - Math.round((Date.parse(from) - Date.parse(ws)) / 864e5);
    const need = Math.min(pw, avail) - count;
    const daysLeft = 7 - dow; // разом із сьогодні
    return need > 0 && need >= daysLeft;
  });
  if (!left.length) return null;
  const names = left.slice(0, 3).map((h) => h.name).join(', ') + (left.length > 3 ? '…' : '');
  const n = left.length;
  const word = n % 10 === 1 && n % 100 !== 11 ? 'звичка' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'звички' : 'звичок';
  return {
    title: n === habits.length ? 'Ще нічого не відмічено' : `Залишилось: ${n} ${word}`,
    body: `${names}. Немає сил? Зроби мінімум — ланцюжок не порветься.`,
    tag: 'daily-reminder',
    url: '/?tab=today'
  };
}
