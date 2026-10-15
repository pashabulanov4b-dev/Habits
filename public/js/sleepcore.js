// «Режим сну» — чиста логіка без DOM. Її використовують і застосунок, і сервер (нагадування).

export const SLEEP_DEFAULTS = { curBed: '03:00', curWake: '11:00', tgtBed: '00:30', tgtWake: '08:00' };
// Готовий план для стандартних часів (03:00/11:00 → 00:30/08:00)
const TABLE = [['10:30', '02:30'], ['09:45', '02:00'], ['09:00', '01:15'], ['08:00', '00:30']];
export const STAGES = 4;
export const WAKE_GRACE = 15;      // «встав вчасно»: допуск +15 хв
export const CREATIVE_BEFORE = 45; // кінець творчості = відбій − 45 хв
export const COFFEE_LAST = '15:00';
export const NAP_LAST = '16:00';

export const NOTIFS = [
  ['wake', 'Підйом'],
  ['light', 'Вийди на світло (+5 хв)'],
  ['coffee', 'Кава — останній шанс (14:45)'],
  ['dim', 'Приглуш світло (відбій − 2 год)'],
  ['ideas', 'Час скинути ідеї'],
  ['bed', 'Відбій через 15 хв']
];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isTime = (s) => TIME_RE.test(s || '');
export const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const fromMin = (m) => {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
};
// відбій рахуємо «від вечора»: 00:30 = 24:30, щоб 23:30 → 00:30 був рухом на годину
const bedAbs = (t) => { const m = toMin(t); return m < 12 * 60 ? m + 1440 : m; };
const round5 = (m) => Math.round(m / 5) * 5;

const dayNum = (k) => { const [y, mo, d] = k.split('-').map(Number); return Math.round(Date.UTC(y, mo - 1, d) / 864e5); };
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);

/** Етапи програми: [{wake, bed, creative}] × 4 */
export function stagesOf(cfg) {
  const c = { ...SLEEP_DEFAULTS, ...pick(cfg) };
  const isDefault = Object.keys(SLEEP_DEFAULTS).every((k) => c[k] === SLEEP_DEFAULTS[k]);
  const out = [];
  for (let i = 1; i <= STAGES; i++) {
    let wake, bed;
    if (isDefault) [wake, bed] = TABLE[i - 1];
    else {
      wake = fromMin(round5(toMin(c.curWake) + (toMin(c.tgtWake) - toMin(c.curWake)) * i / STAGES));
      bed = fromMin(round5(bedAbs(c.curBed) + (bedAbs(c.tgtBed) - bedAbs(c.curBed)) * i / STAGES));
    }
    out.push({ wake, bed, creative: fromMin(toMin(bed) - CREATIVE_BEFORE) });
  }
  return out;
}
function pick(cfg) {
  const o = {};
  for (const k of Object.keys(SLEEP_DEFAULTS)) if (cfg && isTime(cfg[k])) o[k] = cfg[k];
  return o;
}

/** Номер тижня програми (0…) і етап (0…3) на дату; null — програма ще не почалась / вимкнена */
export function stageOn(cfg, date) {
  if (!cfg || !cfg.active || !cfg.start || date < cfg.start) return null;
  const week = Math.floor(daysBetween(cfg.start, date) / 7);
  const idx = Math.min(STAGES - 1, Math.max(0, week - (cfg.repeats || 0)));
  return { week, idx };
}

/** План на дату: часи етапу + рання зміна (свій час підйому) */
export function planOn(cfg, days, date) {
  const st = stageOn(cfg, date);
  if (!st) return null;
  const s = stagesOf(cfg)[st.idx];
  const day = days && days[date];
  const shift = day && isTime(day.shift) ? day.shift : '';
  return { ...st, ...s, planWake: s.wake, wake: shift || s.wake, shift };
}

/** Сповіщення на сьогодні: [{key, at, title, body}] */
export function sleepNotifs(plan) {
  if (!plan) return [];
  return [
    { key: 'wake', at: plan.wake, title: 'Час вставати', body: `Підйом за планом — ${plan.wake}. Одразу на світло.` },
    { key: 'light', at: fromMin(toMin(plan.wake) + 5), title: 'Вийди на світло', body: '20 хвилин денного світла — так сон зсувається швидше.' },
    { key: 'coffee', at: '14:45', title: 'Кава — останній шанс', body: 'Після 15:00 уже без кави.' },
    { key: 'dim', at: fromMin(toMin(plan.bed) - 120), title: 'Приглуш світло', body: 'До відбою 2 години: тепле світло, Night Shift.' },
    { key: 'ideas', at: plan.creative, title: 'Час скинути ідеї', body: '5 хвилин — запиши все в «Нічні ідеї», далі тільки спокійні справи.' },
    { key: 'bed', at: fromMin(toMin(plan.bed) - 15), title: 'Відбій через 15 хв', body: `Лягай о ${plan.bed}.` }
  ];
}

/**
 * Які сповіщення надіслати зараз (крон кожні ~15 хв).
 * local: {date, minutes}; sent: {key: timestampMs}; now: ms
 */
export function dueSleep(cfg, days, local, sent = {}, now = Date.now()) {
  // нічні сповіщення після півночі ще належать до «вчорашнього» плану, але часи етапу ті самі
  const plan = planOn(cfg, days, local.date) || planOn(cfg, days, prevDate(local.date));
  if (!plan) return [];
  const on = cfg.notif || {};
  const out = sleepNotifs(plan).filter((n) => {
    if (on[n.key] === false) return false;
    const diff = (local.minutes - toMin(n.at) + 1440) % 1440;
    if (!(diff <= 25 || diff >= 1440 - 7)) return false;
    return !(sent[n.key] && now - sent[n.key] < 3 * 3600e3);
  });
  // «світло» не шлемо разом із «підйомом» — воно прийде наступним запуском
  return out.some((n) => n.key === 'wake') ? out.filter((n) => n.key !== 'light') : out;
}
export function prevDate(k) {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return t.toISOString().slice(0, 10);
}

/** Тривалість сну в хвилинах: відбій (напередодні) → підйом */
export function sleepMinutes(bed, wake) {
  if (!isTime(bed) || !isTime(wake)) return null;
  let d = toMin(wake) - toMin(bed);
  if (d <= 0) d += 1440;
  return d > 20 * 60 ? null : d;
}
