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

const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : 20 * 60;
};

// Розклад запускається що ~15 хв і може запізнюватися, тому вікно — 3 години після заданого часу.
export function isDue(cfg, now) {
  if (!cfg || !cfg.enabled || !cfg.subs || !cfg.subs.length) return { due: false };
  const local = localParts(now, cfg.tz);
  const diff = local.minutes - toMin(cfg.time);
  if (cfg.lastSent === local.date) return { due: false, local };
  return { due: diff >= 0 && diff < 180, local };
}

export function buildMessage(habitsAll, marksAll, date) {
  const habits = Object.values(habitsAll || {}).map(parse).filter((h) => !h.deleted && h.start <= date);
  if (!habits.length) return null;
  const left = habits.filter((h) => {
    const m = marksAll && marksAll[h.id + '|' + date];
    return !(m && parse(m).value > 0);
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
