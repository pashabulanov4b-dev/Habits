import { db, requestPersistence } from './db.js';
import { initSync, scheduleSync, syncNow, onSyncStatus, getUserId, adoptUserId } from './sync.js';
import { isIOS, isStandalone, getNotifySettings, setDaily, updateTime, ensureTaskPush } from './notify.js';
import { openIntro, maybeShowIntro } from './intro.js';
import { stagesOf, stageOn, planOn, sleepMinutes, NOTIFS, SLEEP_DEFAULTS, toMin, fromMin, isTime, WAKE_GRACE, STAGES } from './sleepcore.js';

/* ================= Дати ================= */
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
const todayKey = () => keyOf(new Date());
const WD_SHORT = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const fmtWeekday = new Intl.DateTimeFormat('uk', { weekday: 'long' });
const fmtDM = new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long' });
// «неділя, 11 жовтня» (а не «неділю…», як дає спільний формат)
const fmtLong = { format: (d) => fmtWeekday.format(d) + ', ' + fmtDM.format(d) };
const fmtMonth = new Intl.DateTimeFormat('uk', { month: 'long', year: 'numeric' });
const fmtDayMonth = new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long' });
const fmtTime = new Intl.DateTimeFormat('uk', { hour: '2-digit', minute: '2-digit' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= Стан ================= */
const S = {
  habits: [],
  marks: new Map(),
  tab: 'today',
  today: todayKey(),
  selDate: todayKey(),
  monthOffset: 0,
  period: 'week',
  progMode: 'week', // прогрес: week | month | table
  sync: { state: 'idle', pending: 0, lastSync: null },
  installPrompt: null,
  // планувальник
  tasks: [],
  rules: [],          // правила повторення
  taskIds: new Set(), // усі id завдань (і видалених) — щоб не створити видалену копію вдруге
  planMode: 'day',     // day | ahead | cal
  planDate: todayKey(),
  calOffset: 0,
  // щоденник
  journal: [],
  jFilter: 'all',   // all | me | habit | task
  jSearch: false,
  jQuery: '',
  // режим сну
  sleepCfg: null,
  sleepDays: {},
  ideas: []
};

async function loadState() {
  const [habits, marks, tasks, journal, sleep] = await Promise.all([db.getAll('habits'), db.getAll('marks'), db.getAll('tasks'), db.getAll('journal'), db.getAll('sleep')]);
  S.habits = habits.filter((h) => !h.deleted).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  S.marks = new Map(marks.map((m) => [m.k, { value: m.value, amount: m.amount ?? null, note: m.note || '', jAt: m.jAt || 0 }]));
  S.taskIds = new Set(tasks.map((t) => t.id));
  S.rules = tasks.filter((t) => !t.deleted && isRule(t));
  S.tasks = tasks.filter((t) => !t.deleted && !isRule(t));
  S.journal = journal.filter((j) => !j.deleted);
  S.sleepCfg = sleep.find((r) => r.id === 's-cfg' && !r.deleted) || null;
  S.sleepDays = Object.fromEntries(sleep.filter((r) => r.kind === 'day' && !r.deleted).map((r) => [r.date, r]));
  S.ideas = sleep.filter((r) => r.kind === 'idea' && !r.deleted).sort((a, b) => b.createdAt - a.createdAt);
}

const markOf = (hid, date) => S.marks.get(hid + '|' + date);
const habitById = (id) => S.habits.find((h) => h.id === id);
// Стан відмітки 0/1/2. Для звичок з кількістю рахується з числа — тож якщо змінити ціль, старі дні перерахуються.
const val = (hid, date) => {
  const m = markOf(hid, date);
  if (!m) return 0;
  const h = habitById(hid);
  if (isCount(h) && m.amount != null) return valueForAmount(h, m.amount);
  return m.value || 0;
};
const amt = (hid, date) => { const m = markOf(hid, date); return m && m.amount != null ? m.amount : null; };
const activeOn = (date) => S.habits.filter((h) => h.start <= date);

/* ===== Звички з кількістю (напр. 19 з 20 сторінок) ===== */
const isCount = (h) => h && h.kind === 'count' && h.target > 0;
const minOf = (h) => Math.min(h.minAmount > 0 ? h.minAmount : h.target, h.target);
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10).replace('.', ','));
const parseNum = (s) => { const n = parseFloat(String(s).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null; };
// Скільки зроблено → стан відмітки: ціль = повністю, від мінімуму = мінімум, менше — не зараховано
function valueForAmount(h, a) {
  if (a == null || a <= 0) return 0;
  if (a >= h.target) return 2;
  if (a >= minOf(h)) return 1;
  return 0;
}
/**
 * Внесок звички в день (0…1):
 * повністю = 100%, мінімум = 50%, а між мінімумом і ціллю — пропорційно.
 * 20 сторінок, мінімум 1: 1 стор. = 50%, 10 стор. ≈ 74%, 19 стор. ≈ 97%, 20 = 100%.
 */
function scoreOf(h, date) {
  const m = markOf(h.id, date);
  if (!m) return 0;
  if (isCount(h) && m.amount != null) {
    const a = m.amount, t = h.target, mn = minOf(h);
    if (a >= t) return 1;
    if (a < mn) return 0;
    return t === mn ? 1 : 0.5 + 0.5 * (a - mn) / (t - mn);
  }
  return m.value === 2 ? 1 : m.value === 1 ? 0.5 : 0;
}

/* ===== Частота: щодня або N разів на тиждень ===== */
// perWeek 1…6 = тижнева звичка; 7 (або нічого) = щодня
const perWeek = (h) => (h && h.perWeek >= 1 && h.perWeek <= 6 ? h.perWeek : 7);
const isDaily = (h) => perWeek(h) === 7;
const weekStart = (date) => addDays(date, -((parseKey(date).getDay() + 6) % 7)); // понеділок
const dailyOn = (date) => activeOn(date).filter(isDaily);
// Скільки разів зроблено за тиждень, що починається з ws (рахуються лише дні до сьогодні)
function weekDone(h, ws) {
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    if (d > S.today) break;
    if (d >= h.start && val(h.id, d) > 0) n++;
  }
  return n;
}
// Скільки треба за цей тиждень. Якщо звичку створено посеред тижня — менше, щоб ціль була досяжна.
function weekNeed(h, ws) {
  const from = h.start > ws ? h.start : ws;
  const avail = Math.max(0, 7 - Math.round((parseKey(from) - parseKey(ws)) / 864e5));
  return Math.min(perWeek(h), avail);
}
const weekMet = (h, ws) => { const need = weekNeed(h, ws); return need > 0 && weekDone(h, ws) >= need; };

// Щоденний відсоток рахується тільки з щоденних звичок:
// тижнева звичка не «псує» день, коли ти за планом відпочиваєш.
function dayScore(date) {
  const hs = dailyOn(date);
  if (!hs.length) return null;
  let s = 0;
  hs.forEach((h) => { s += scoreOf(h, date); });
  return s / hs.length;
}
function dayCounted(date) {
  const hs = dailyOn(date);
  return hs.length > 0 && hs.every((h) => val(h.id, date) > 0);
}
// Ланцюжок: для щоденних — у днях, для тижневих — у тижнях, коли ціль тижня виконана
function streakOf(h) {
  if (!isDaily(h)) {
    let ws = weekStart(S.today);
    let n = weekMet(h, ws) ? 1 : 0;
    ws = addDays(ws, -7);
    const first = weekStart(h.start);
    while (ws >= first && weekMet(h, ws)) { n++; ws = addDays(ws, -7); }
    return n;
  }
  let d = S.today;
  if (!val(h.id, d)) d = addDays(d, -1);
  let n = 0;
  while (d >= h.start && val(h.id, d) > 0) { n++; d = addDays(d, -1); }
  return n;
}
function longestOf(h) {
  let best = 0, run = 0;
  if (!isDaily(h)) {
    for (let ws = weekStart(h.start); ws <= S.today; ws = addDays(ws, 7)) {
      if (weekMet(h, ws)) { run++; if (run > best) best = run; }
      else if (ws !== weekStart(S.today)) run = 0; // поточний тиждень ще не закінчився
    }
    return best;
  }
  for (let d = h.start; d <= S.today; d = addDays(d, 1)) {
    if (val(h.id, d) > 0) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}
const streakLabel = (h) => (isDaily(h) ? String(streakOf(h)) : streakOf(h) + ' тиж.');
const nextVal = (v) => (v === 0 ? 2 : 0); // тап: відмічено ↔ ні (мінімум лишився тільки у звичок з кількістю)

/* ================= Запис змін (спершу на телефон) ================= */
// amount / note: undefined = лишити як було
async function setMark(hid, date, value, amount, note, jAt) {
  const prev = S.marks.get(hid + '|' + date) || {};
  if (amount === undefined) amount = prev.amount ?? null;
  if (note === undefined) note = prev.note || '';
  if (jAt === undefined) jAt = prev.jAt || 0;
  if (!note) jAt = 0;
  const rec = { k: hid + '|' + date, habitId: hid, date, value, amount, note, jAt, updatedAt: Date.now(), dirty: true };
  S.marks.set(rec.k, { value, amount, note, jAt });
  await db.put('marks', rec);
  scheduleSync();
}
async function saveHabit(data) {
  const now = Date.now();
  const fields = { name: data.name, full: data.full, min: data.min, kind: data.kind === 'count' ? 'count' : 'check',
    perWeek: data.perWeek >= 1 && data.perWeek <= 6 ? data.perWeek : 7,
    note: (data.note || '').slice(0, 300), askNote: !!data.askNote };
  if (data.sleep !== undefined) fields.sleep = data.sleep;
  if (fields.kind === 'count') {
    fields.target = data.target;
    fields.minAmount = data.minAmount;
    fields.unit = data.unit || '';
    // текстові описи теж заповнюємо — їх бачать нагадування та старі версії
    fields.full = `${fmtNum(data.target)} ${fields.unit}`.trim();
    fields.min = `${fmtNum(data.minAmount)} ${fields.unit}`.trim();
  }
  let h = data.id ? S.habits.find((x) => x.id === data.id) : null;
  if (h) {
    Object.assign(h, fields, { updatedAt: now, dirty: true });
  } else {
    const maxOrder = S.habits.reduce((m, x) => Math.max(m, x.order), 0);
    h = { id: 'h-' + now.toString(36) + Math.random().toString(36).slice(2, 7), ...fields,
      order: maxOrder + 1, start: S.today, createdAt: now, updatedAt: now, deleted: false, dirty: true };
    S.habits.push(h);
  }
  await db.put('habits', { ...h });
  scheduleSync();
  return h;
}
async function deleteHabit(id) {
  const h = S.habits.find((x) => x.id === id);
  if (!h) return;
  S.habits = S.habits.filter((x) => x.id !== id);
  await db.put('habits', { ...h, deleted: true, updatedAt: Date.now(), dirty: true });
  scheduleSync();
}

/* ================= Іконки ================= */
const I = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  flame: '<svg viewBox="0 0 24 24"><path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h11M9 8.5h6"/></svg>'
};

/* ================= Навігація ================= */
const views = document.getElementById('views');
const TABS = ['today', 'plan', 'journal', 'progress'];

function showTab(tab, { animate = true } = {}) {
  S.tab = tab;
  const nav = navTab();
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === nav));
  moveIndicator();
  planBar.classList.toggle('show', tab === 'plan');
  const old = views.querySelector('.view:not(.leave)');
  const el = document.createElement('section');
  el.className = 'view' + (animate ? ' enter' : '');
  el.dataset.view = tab;
  views.appendChild(el);
  renderView(el);
  if (old) {
    old.classList.add('leave');
    setTimeout(() => old.remove(), 230);
  }
}
const navTab = () => (S.tab === 'sleep' ? 'today' : S.tab); // «Режим сну» — частина розділу «Звички»
function moveIndicator() {
  const ind = document.querySelector('.tab-indicator');
  const tab = document.querySelector(`.tab[data-tab="${navTab()}"]`);
  if (!ind || !tab) return;
  ind.style.width = tab.offsetWidth + 'px';
  ind.style.height = tab.offsetHeight + 'px';
  ind.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
}
function currentView() { return views.querySelector('.view:not(.leave)'); }
function renderView(el = currentView()) {
  if (!el) return;
  if (el.dataset.view === 'today') renderToday(el);
  if (el.dataset.view === 'plan') renderPlan(el);
  if (el.dataset.view === 'journal') renderJournal(el);
  if (el.dataset.view === 'sleep') renderSleep(el);
  if (el.dataset.view === 'progress') renderProgress(el);
}
// Тихе оновлення: без каскадної анімації появи (після відмітки, синхронізації)
function rerender() {
  const el = currentView();
  if (!el) return;
  const top = el.scrollTop;
  el.classList.remove('enter');
  el.classList.add('static');
  renderView(el);
  el.scrollTop = top;
}

/* ================= Спільні частини: шапка й перемикач ================= */
// Одна шапка для всіх екранів: дрібний підпис, великий заголовок зліва, кнопки справа
function headHTML({ eyebrow, title, actions = '', back = '', dot = true }) {
  return `<div class="head">
    <div class="${back ? 'hd-back' : ''}">${back}<div><div class="eyebrow">${dot ? `<span class="${syncDotClass()}" data-sync-dot></span>` : ''}${esc(eyebrow)}</div><h1>${esc(title)}</h1></div></div>
    ${actions ? `<div class="head-actions">${actions}</div>` : ''}
  </div>`;
}
// Один перемикач для всього застосунку
function segHTML(items, current, act, label) {
  return `<div class="useg" role="tablist" aria-label="${esc(label)}">${items.map(([k, l]) =>
    `<button role="tab" data-act="${act}" data-v="${k}" class="${k === current ? 'on' : ''}" aria-selected="${k === current}">${l}</button>`).join('')}</div>`;
}

/* ================= Екран «Сьогодні» ================= */
const RING_C = 2 * Math.PI * 52;
const TEMPLATES = [
  { name: 'Читання', kind: 'count', target: 20, minAmount: 1, unit: 'стор.' },
  { name: 'Спорт', kind: 'count', target: 30, minAmount: 5, unit: 'хв', perWeek: 3 },
  { name: 'Вода', kind: 'count', target: 8, minAmount: 4, unit: 'склянок' },
  { name: 'Сон до 23:00', kind: 'check', full: 'лягти до 23:00', min: 'лягти до 00:00' },
  { name: 'Медитація', kind: 'count', target: 10, minAmount: 2, unit: 'хв' },
  { name: 'Іноземна мова', kind: 'count', target: 30, minAmount: 5, unit: 'хв' }
];

function syncDotClass() { return 'sync-dot ' + (S.sync.state === 'syncing' ? 'syncing' : S.sync.state === 'offline' ? 'offline' : S.sync.state === 'error' ? 'error' : ''); }

function todaySummary() {
  const date = S.selDate;
  const hs = dailyOn(date);
  const weekly = activeOn(date).filter((h) => !isDaily(h));
  const ws = weekStart(date);
  const weeklyMet = weekly.filter((h) => weekMet(h, ws)).length;
  const counted = hs.filter((h) => val(h.id, date) > 0).length;
  const full = hs.filter((h) => val(h.id, date) === 2).length;
  let frac = dayScore(date) ?? 0;
  const left = hs.length - counted;
  let head = `${counted} з ${hs.length} ${plural(hs.length, 'звички', 'звичок', 'звичок')}`;
  let sub = left ? `Ще ${left} — і день зараховано` : '';
  if (hs.length && full === hs.length) { head = 'Ідеальний день'; sub = 'Усе виконано. Так тримати'; }
  else if (hs.length && counted === hs.length) { head = 'День зараховано'; sub = 'Ланцюжок цілий'; }
  if (!hs.length && weekly.length) {
    // лише тижневі звички: кільце показує прогрес тижня
    frac = weekly.reduce((s, h) => s + Math.min(1, weekDone(h, ws) / (weekNeed(h, ws) || 1)), 0) / weekly.length;
    head = `Тиждень: ${weeklyMet} з ${weekly.length}`;
    sub = 'Тижневі звички — у будь-які дні';
  }
  return { frac, head, sub, counted, total: hs.length, any: hs.length + weekly.length };
}

// Підпис тижневої звички: «Цей тиждень: 1 / 3»
function weekLine(h, date = S.selDate) {
  if (isDaily(h)) return '';
  const ws = weekStart(date);
  const done = weekDone(h, ws), need = weekNeed(h, ws);
  return done >= need ? `<span class="wk ok">Тиждень ✓ ${done}/${need}</span>` : `<span class="wk">Тиждень ${done}/${need}</span>`;
}

const noteOf = (hid, date) => (markOf(hid, date) || {}).note || '';
function habitSub(h, v, date = S.selDate) {
  const n = noteOf(h.id, date);
  if (n) return `<span class="hn">${INOTE}${esc(n)}</span>`;
  if (h.sleep) { const s = sleepSub(h, v, date); if (s) return s; }
  if (!isCount(h) && !isDaily(h)) {
    const ws = weekStart(date), done = weekDone(h, ws), need = weekNeed(h, ws);
    return done >= need ? `<em>${done} з ${need}</em> цього тижня ✓` : `${done} з ${need} цього тижня`;
  }
  if (isCount(h)) {
    const a = amt(h.id, date);
    const u = h.unit ? ' ' + esc(h.unit) : '';
    if (a != null && a > 0) {
      const left = h.target - a;
      return `<em>${fmtNum(a)}</em> / ${fmtNum(h.target)}${u}`;
    }
    return `0 / ${fmtNum(h.target)}${u}`;
  }
  return '';
}

// Кружок справа: галочка / МІН / число (19) для часткового виконання
function checkInner(h, v, date = S.selDate) {
  const a = isCount(h) ? amt(h.id, date) : null;
  const label = a != null && a > 0 && v !== 2 ? fmtNum(a) : 'МІН';
  return `${I.check}<span class="min">${label}</span>`;
}
function rowClass(h, v, date = S.selDate) {
  const a = isCount(h) ? amt(h.id, date) : null;
  const rest = !isDaily(h) && v === 0 && weekMet(h, weekStart(date)); // тижнева ціль уже є — сьогодні можна відпочити
  return `habit glass v${v}${isCount(h) ? ' count' : ''}${v === 0 && a > 0 ? ' part' : ''}${rest ? ' rest' : ''}`;
}
function barWidth(h, date = S.selDate) {
  const a = amt(h.id, date) || 0;
  return Math.min(100, Math.round(a / h.target * 100));
}

function renderToday(el) {
  const date = S.selDate;
  const isToday = date === S.today;
  const yest = addDays(S.today, -1);
  const title = isToday ? 'Сьогодні' : date === yest ? 'Вчора' : cap(new Intl.DateTimeFormat('uk', { weekday: 'long' }).format(parseKey(date)));
  const t = parseKey(S.today);
  const monday = addDays(S.today, -((t.getDay() + 6) % 7));
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(monday, i);
    const sc = dayScore(d);
    week.push(`<button class="day${d === date ? ' sel' : ''}${d > S.today ? ' future' : ''}" data-act="day" data-date="${d}" aria-label="${esc(fmtLong.format(parseKey(d)))}">
      <span class="wd">${WD_SHORT[parseKey(d).getDay()]}</span><span class="dn">${parseKey(d).getDate()}</span>
      <span class="mini"><i style="width:${Math.round((sc || 0) * 100)}%"></i></span></button>`);
  }
  const sum = todaySummary();
  const hs = activeOn(date);

  const install = installBannerHTML();
  const list = hs.length
    ? `<div class="habits stagger">${hs.map((h, i) => {
        const v = val(h.id, date);
        return `<button class="${rowClass(h, v)}" data-act="habit" data-id="${h.id}" style="--i:${i}" aria-label="${esc(h.name)}">
          <span class="meta"><span class="name">${esc(h.name)}</span><span class="sub">${habitSub(h, v)}</span></span>
          ${h.askNote ? `<span class="hnote${noteOf(h.id, date) ? ' has' : ''}" role="button" tabindex="0" data-act="habit-note" data-id="${h.id}" aria-label="Нотатка за день">${INOTE}</span>` : ''}
          <span class="streak">${I.flame}<span>${streakOf(h)}</span></span>
          <span class="check">${checkInner(h, v)}</span>
          ${isCount(h) ? `<span class="hbar"><i style="width:${barWidth(h)}%"></i></span>` : ''}</button>`;
      }).join('')}</div>
`
    : S.habits.length
      ? `<div class="empty glass"><p>Цього дня звичок ще не було.</p></div>`
      : `<div class="empty glass">
          <h2>Почнімо з однієї звички</h2>
          <p>Додай першу звичку або візьми одну з готових.</p>
          <div class="chips">${TEMPLATES.map((tp, i) => `<button class="chip glass press" data-act="template" data-i="${i}">${esc(tp.name)}</button>`).join('')}</div>
          <button class="btn primary press" data-act="add">${I.plus.replace('<svg', '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')}Своя звичка</button>
        </div>`;

  el.innerHTML = `
    ${headHTML({ eyebrow: cap(fmtLong.format(parseKey(date))), title,
      actions: `<button class="icon-btn glass press" data-act="settings" aria-label="Налаштування">${I.gear}</button><button class="icon-btn lime press" data-act="add" aria-label="Додати звичку">${I.plus}</button>` })}
    ${install}
    <div class="cols">
    <div class="col sticky">
    <div class="week">${week.join('')}</div>
    <div class="progress-card glass${sum.total && sum.counted === sum.total ? ' done' : ''}" data-progress>
      <div class="ring"><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/><circle class="bar" cx="60" cy="60" r="52" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}" data-ring/></svg>
        <div class="val"><div><b data-pct>0%</b></div></div></div>
      <div class="txt"><b data-headline>${sum.any ? sum.head : 'Ще немає звичок'}</b><span data-sub>${sum.any ? sum.sub : 'Додай першу — і відмічай щодня'}</span></div>
    </div>
    ${sleepCardHTML()}
    </div>
    <div class="col">${list}</div>
    </div>`;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ring = el.querySelector('[data-ring]');
    if (ring) ring.style.strokeDashoffset = RING_C * (1 - sum.frac);
    countTo(el.querySelector('[data-pct]'), Math.round(sum.frac * 100), '%');
  }));
}

function updateTodayDynamic(row) {
  const el = currentView();
  if (!el || el.dataset.view !== 'today') return;
  const sum = todaySummary();
  const ring = el.querySelector('[data-ring]');
  if (ring) ring.style.strokeDashoffset = RING_C * (1 - sum.frac);
  countTo(el.querySelector('[data-pct]'), Math.round(sum.frac * 100), '%');
  el.querySelector('[data-headline]').textContent = sum.head;
  el.querySelector('[data-sub]').textContent = sum.sub;
  const card = el.querySelector('[data-progress]');
  card.classList.toggle('done', sum.total > 0 && sum.counted === sum.total);
  const mini = el.querySelector(`.day[data-date="${S.selDate}"] .mini i`);
  if (mini) mini.style.width = Math.round(sum.frac * 100) + '%';
  if (row) {
    const h = S.habits.find((x) => x.id === row.dataset.id);
    const v = val(h.id, S.selDate);
    row.className = rowClass(h, v);
    row.querySelector('.sub').innerHTML = habitSub(h, v);
    row.querySelector('.hnote')?.classList.toggle('has', !!noteOf(h.id, S.selDate));
    row.querySelector('.streak span').textContent = streakLabel(h);
    const nm = row.querySelector('.name');
    nm.innerHTML = esc(h.name) + weekLine(h);
    row.querySelector('.check').innerHTML = checkInner(h, v);
    const bar = row.querySelector('.hbar i');
    if (bar) bar.style.width = barWidth(h) + '%';
  }
  return sum;
}

function countTo(el, to, suffix = '') {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (reduceMotion() || from === to) { el.textContent = to + suffix; return; }
  const t0 = performance.now();
  const dur = 700;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * e) + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ================= Екран «Таблиця» ================= */
function monthInfo() {
  const t = parseKey(S.today);
  const first = new Date(t.getFullYear(), t.getMonth() + S.monthOffset, 1);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const keys = [];
  for (let i = 1; i <= days; i++) keys.push(keyOf(new Date(first.getFullYear(), first.getMonth(), i)));
  return { first, keys, start: keys[0], end: keys[keys.length - 1] };
}
function earliestStart() { return S.habits.reduce((m, h) => (h.start < m ? h.start : m), S.today); }

function tableStats(mi) {
  let counted = 0, eligible = 0, sum = 0;
  mi.keys.forEach((d) => {
    if (d > S.today) return;
    const sc = dayScore(d);
    if (sc === null) return;
    eligible++; sum += sc;
    if (dayCounted(d)) counted++;
  });
  return { counted, eligible, avg: eligible ? Math.round(sum / eligible * 100) : 0 };
}
function tableKpis(mi) {
  const t = tableStats(mi);
  return `<div class="glass"><b>${t.avg}%</b><small>середній день</small></div>
    <div class="glass"><b>${t.counted} ${plural(t.counted, 'день', 'дні', 'днів')}</b><small>усе виконано</small></div>`;
}
function rowScore(h, mi) {
  let any = 0, el = 0;
  mi.keys.forEach((d) => { if (d <= S.today && d >= h.start) { el++; if (val(h.id, d) > 0) any++; } });
  return `${any}/${el} днів`;
}

function renderTable(el) {
  const mi = monthInfo();
  const hs = S.habits.filter((h) => h.start <= mi.end);
  const prevDisabled = mi.start <= earliestStart();
  const head = mi.keys.map((d) => {
    const dt = parseKey(d);
    return `<div class="h${d === S.today ? ' today' : ''}${d > S.today ? ' future' : ''}"><small>${WD_SHORT[dt.getDay()]}</small><b>${dt.getDate()}</b></div>`;
  }).join('');
  const rows = hs.map((h) => `<div class="grow">${mi.keys.map((d) => {
    let cls = 'cell';
    if (d > S.today) cls += ' future';
    else if (d < h.start) cls += ' na';
    else cls += ' v' + val(h.id, d) + (noteOf(h.id, d) ? ' nt' : '');
    if (d === S.today) cls += ' today';
    return `<button class="${cls}" data-act="cell" data-id="${h.id}" data-date="${d}" aria-label="${esc(h.name)}, ${parseKey(d).getDate()}"></button>`;
  }).join('')}</div>`).join('');
  const bars = mi.keys.map((d, i) => {
    const raw = d <= S.today ? dayScore(d) : null;
    const sc = raw || 0;
    return `<div class="bw${d === S.today ? ' today' : ''}" data-bar="${d}"><i style="--i:${i};height:${Math.max(3, Math.round(sc * 28))}px;${raw === null ? 'background:rgba(255,255,255,.1)' : ''}"></i></div>`;
  }).join('');

  el.innerHTML = `
    ${headHTML({ eyebrow: `Середній день — ${tableStats(mi).avg}%`, title: 'Прогрес' })}
    ${progSeg()}
    <div class="mnav">
      <button class="icon-btn small press" data-act="month" data-d="-1" aria-label="Попередній місяць" ${prevDisabled ? 'disabled' : ''}>${I.left}</button>
      <b>${esc(cap(fmtMonth.format(mi.first).replace(' р.', '')))}</b>
      <button class="icon-btn small press" data-act="month" data-d="1" aria-label="Наступний місяць" ${S.monthOffset >= 0 ? 'disabled' : ''}>${I.right}</button>
    </div>
    ${hs.length ? `
    <div class="grid-card glass">
      <div class="grid-names">
        <div style="height:34px"></div>
        ${hs.map((h) => `<div class="nm"><b>${esc(h.name)}</b></div>`).join('')}
        <div class="grid-labels">День</div>
      </div>
      <div class="grid-scroll" data-gscroll>
        <div class="grid-cols">
          <div class="grow ghead">${head}</div>
          ${rows}
          <div class="grow gbars">${bars}</div>
        </div>
      </div>
    </div>
    <div class="pg-kp" data-kpis>${tableKpis(mi)}</div>`
    : `<div class="empty glass"><p>Цього місяця звичок ще не було.</p></div>`}`;

  const sc = el.querySelector('[data-gscroll]');
  if (sc && S.monthOffset === 0) {
    const idx = mi.keys.indexOf(S.today);
    sc.scrollLeft = Math.max(0, idx * 30 - sc.clientWidth / 2);
  }
}

/* ================= Екран «Прогрес» = статистика + таблиця ================= */
const progSeg = () => segHTML([['week', 'Тиждень'], ['month', 'Місяць'], ['table', 'Таблиця']], S.progMode, 'prog', 'Прогрес');
function renderProgress(el) {
  if (S.progMode === 'table') renderTable(el);
  else { S.period = S.progMode; renderStats(el); }
}
function periodDays(period, endKey) {
  const n = period === 'week' ? 7 : parseKey(endKey).getDate();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
  return out;
}
function avgScore(days) {
  let s = 0, n = 0;
  days.forEach((d) => { const v = dayScore(d); if (v !== null) { s += v; n++; } });
  return n ? s / n : null;
}

function renderStats(el) {
  const days = periodDays(S.period, S.today);
  const prevEnd = S.period === 'week' ? addDays(days[0], -1) : addDays(keyOf(new Date(parseKey(S.today).getFullYear(), parseKey(S.today).getMonth(), 1)), -1);
  const prevDays = S.period === 'week' ? periodDays('week', prevEnd) : periodDays('month', prevEnd);
  const cur = avgScore(days);
  const prev = avgScore(prevDays);
  let delta = S.period === 'week' ? 'перший тиждень' : 'перший місяць';
  if (cur !== null && prev !== null) {
    const d = Math.round((cur - prev) * 100);
    const what = S.period === 'week' ? 'минулого тижня' : 'минулого місяця';
    delta = d === 0 ? `як і ${what}` : `${d > 0 ? '+' : '−'}${Math.abs(d)}% до ${what}`;
  }
  // рекорд ланцюжка: серед щоденних звичок у днях; якщо щоденних нема — серед тижневих у тижнях
  let best = { n: 0, name: '', weeks: false };
  const pool = S.habits.some(isDaily) ? S.habits.filter(isDaily) : S.habits;
  pool.forEach((h) => { const n = longestOf(h); if (n > best.n) best = { n, name: h.name, weeks: !isDaily(h) }; });
  const scored = days.filter((d) => d <= S.today && dayScore(d) !== null);
  const fullDays = scored.filter((d) => dayCounted(d)).length;
  const bars = days.map((d, i) => {
    const sc = d <= S.today ? dayScore(d) || 0 : 0;
    const label = S.period === 'week' ? WD_SHORT[parseKey(d).getDay()] : (i % 5 === 0 || d === S.today ? String(parseKey(d).getDate()) : '');
    return `<div class="pg-col${d === S.today ? ' today' : ''}"><div class="pg-tr"><i style="--i:${i};height:${Math.max(4, Math.round(sc * 100))}%"></i></div><small>${label || '&nbsp;'}</small></div>`;
  }).join('');

  const last7 = periodDays('week', S.today);
  const habits = S.habits.map((h) => {
    let any = 0, eligible = 0;
    days.forEach((d) => { if (d >= h.start) { eligible++; if (val(h.id, d) > 0) any++; } });
    // для тижневих звичок очікується perWeek разів на кожні 7 днів
    const expected = isDaily(h) ? eligible : Math.max(1, Math.round(perWeek(h) * eligible / 7));
    const pct = eligible ? Math.min(100, Math.round(any / expected * 100)) : 0;
    const dots = last7.map((d) => `<i class="${d < h.start ? 'na' : val(h.id, d) > 0 ? 'y' : ''}"></i>`).join('');
    const tag = isDaily(h) ? '' : `<small class="fq">${perWeek(h)}×/тиж</small>`;
    return `<div class="hrow"><span class="n">${esc(h.name)}${tag}</span><span class="dots">${dots}</span><span class="p">${pct}%</span></div>`;
  }).join('');

  const range = S.period === 'week'
    ? `${parseKey(days[0]).getDate()} – ${fmtDayMonth.format(parseKey(S.today))}`
    : cap(fmtMonth.format(parseKey(S.today)).replace(' р.', ''));

  el.innerHTML = `
    ${headHTML({ eyebrow: range, title: 'Прогрес' })}
    ${progSeg()}
    <div class="cols">
    <div class="col stagger">
      <div class="pg-big glass" style="--i:0">
        <div class="pg-n"><b data-total>0%</b><span>виконано · ${esc(delta)}</span></div>
        <div class="pg-bars${S.period === 'month' ? ' month' : ''}">${bars}</div>
      </div>
      <div class="pg-kp" style="--i:1">
        <div class="glass"><b>${best.n} ${best.weeks ? plural(best.n, 'тиждень', 'тижні', 'тижнів') : plural(best.n, 'день', 'дні', 'днів')}</b><small>${best.n ? 'найдовший ланцюжок · ' + esc(best.name) : 'найдовший ланцюжок'}</small></div>
        <div class="glass"><b>${fullDays} з ${scored.length}</b><small>днів повністю зараховано</small></div>
      </div>
    </div>
    <div class="col stagger">
      ${S.habits.length ? `<div class="hlist glass" style="--i:2"><div class="top">Звички<span>останні 7 днів</span></div>${habits}</div>` : ''}
    </div>
    </div>`;

  requestAnimationFrame(() => {
    countTo(el.querySelector('[data-total]'), Math.round((cur || 0) * 100), '%');
  });
}
function placeKnob(el) {
  const seg = el.querySelector('.seg');
  if (!seg) return;
  const on = seg.querySelector('button.on');
  const knob = seg.querySelector('.knob');
  knob.style.width = on.offsetWidth + 'px';
  knob.style.transform = `translateX(${on.offsetLeft - 4}px)`;
  knob.style.left = '4px';
}
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ================= Банер встановлення ================= */
function installBannerHTML() {
  if (isStandalone() || localStorage.getItem('installDismissed')) return '';
  if (isIOS()) {
    return `<div class="install glass">${I.share}<div>Встанови на екран: <b>Поділитися</b> → <b>На початковий екран</b>. Так буде повний екран, офлайн і сповіщення.</div><button data-act="dismiss-install" aria-label="Закрити">${I.x}</button></div>`;
  }
  if (S.installPrompt) {
    return `<div class="install glass">${I.share}<div>Встанови застосунок, щоб він відкривався на весь екран і без інтернету.</div><button class="small-btn" style="width:auto;margin-left:auto" data-act="install">Встановити</button></div>`;
  }
  return '';
}

/* ================= Нижні листи ================= */
const sheetRoot = document.getElementById('sheet-root');
function openSheet(html, onMount) {
  closeSheet(true);
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  sheetRoot.appendChild(wrap);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });
  if (onMount) onMount(wrap.querySelector('.sheet'));
  return wrap;
}
sheetRoot.addEventListener('click', (e) => {
  const sw = e.target.closest('[data-journal]');
  if (sw) sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
});
function closeSheet(instant = false) {
  const w = sheetRoot.querySelector('.sheet-wrap');
  if (!w) return;
  if (instant || reduceMotion()) { w.remove(); return; }
  w.classList.add('closing');
  setTimeout(() => w.remove(), 280);
}

function openHabitSheet(h = null) {
  const v = h || { name: '', full: '', min: '', kind: 'check', target: '', minAmount: '', unit: '' };
  let kind = isCount(v) || (!h && v.kind === 'count') ? 'count' : 'check';
  openSheet(`
    <h2>${h ? 'Редагувати звичку' : 'Нова звичка'}</h2>
    <input id="f-name" class="big-input" maxlength="40" placeholder="Назва, напр. Спорт" value="${esc(v.name)}" autocomplete="off" aria-label="Назва">
    <div class="useg" role="tablist" data-kind-seg>
      <button type="button" role="tab" data-kind="check">Так / ні</button>
      <button type="button" role="tab" data-kind="count">Кількість</button>
    </div>
    <div data-kind-count>
      <div class="field-row">
        <div class="field"><label for="f-target">Ціль</label><input id="f-target" inputmode="decimal" placeholder="20" value="${esc(v.target ?? '')}" autocomplete="off"></div>
        <div class="field"><label for="f-minamt">Мінімум</label><input id="f-minamt" inputmode="decimal" placeholder="1" value="${esc(v.minAmount ?? '')}" autocomplete="off"></div>
      </div>
      <div class="field"><label for="f-unit">Одиниця</label><input id="f-unit" maxlength="16" placeholder="стор., хв, склянок, км…" value="${esc(v.unit || '')}" autocomplete="off">
        <small>Мінімум — настільки мало, щоб це можна було зробити за будь-якого настрою.</small></div>
    </div>
    <div data-kind-check>
      <input id="f-full" class="big-input small" maxlength="40" placeholder="Мета (необовʼязково)" value="${esc(isCount(v) ? '' : v.full)}" autocomplete="off" aria-label="Мета">
    </div>
    <div class="gh">Як часто</div>
    <div class="set-group">
      <div class="set-row"><div class="l"><b>Щодня</b></div><button type="button" class="switch" role="switch" data-daily aria-label="Щодня"></button></div>
      <div class="set-row" data-pw-row><div class="l"><b>Разів на тиждень</b><span>у будь-які дні</span></div>
        <div class="stepper"><button type="button" data-pw-d="-1" aria-label="Менше">−</button><b data-pw-v></b><button type="button" data-pw-d="1" aria-label="Більше">+</button></div></div>
    </div>
    <div class="set-group">
      <button type="button" class="set-row link" data-open-note><div class="l"><b>Нотатка до звички</b></div><span class="v">${v.note ? '' : 'Додати'}</span>${I.right}</button>
      <div class="sbody" data-note-body ${v.note ? '' : 'hidden'}><textarea id="f-note" class="note-input" rows="2" maxlength="300" placeholder="Навіщо мені це, як роблю, що допомагає…">${esc(v.note || '')}</textarea></div>
      <div class="set-row"><div class="l"><b>Спитати «Як пройшло?»</b></div>
        <button type="button" class="switch" role="switch" aria-checked="${!!v.askNote}" aria-label="Питати нотатку при відмітці" data-asknote></button></div>
    </div>
    ${h ? recentNotesHTML(h) : ''}
    <button class="btn primary block press" data-save>${h ? 'Зберегти' : 'Додати'}</button>
    ${h ? '<button class="btn danger block press" data-del>Видалити звичку</button>' : ''}
  `, (sheet) => {
    const name = sheet.querySelector('#f-name');
    const ask = sheet.querySelector('[data-asknote]');
    ask.addEventListener('click', () => ask.setAttribute('aria-checked', ask.getAttribute('aria-checked') !== 'true'));
    sheet.querySelectorAll('[data-note-day]').forEach((b) => b.addEventListener('click', () => openNoteSheet(h, b.dataset.noteDay)));
    const seg = sheet.querySelector('[data-kind-seg]');
    const applyKind = () => {
      seg.querySelectorAll('button').forEach((b) => { const on = b.dataset.kind === kind; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      sheet.querySelector('[data-kind-count]').hidden = kind !== 'count';
      sheet.querySelector('[data-kind-check]').hidden = kind !== 'check';
    };
    sheet.querySelector('[data-open-note]').addEventListener('click', (e) => {
      const b = sheet.querySelector('[data-note-body]'); b.hidden = !b.hidden;
      if (!b.hidden) { e.currentTarget.querySelector('.v').textContent = ''; sheet.querySelector('#f-note').focus(); }
    });
    seg.addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { kind = b.dataset.kind; applyKind(); } });
    requestAnimationFrame(applyKind);
    let pw = h ? perWeek(h) : 7;
    let weekly = pw < 7 ? pw : 3;
    const daily = sheet.querySelector('[data-daily]');
    const applyFreq = () => {
      daily.setAttribute('aria-checked', String(pw === 7));
      sheet.querySelector('[data-pw-row]').classList.toggle('off', pw === 7);
      sheet.querySelector('[data-pw-v]').textContent = weekly;
    };
    daily.addEventListener('click', () => { pw = pw === 7 ? weekly : 7; applyFreq(); });
    sheet.querySelectorAll('[data-pw-d]').forEach((b) => b.addEventListener('click', () => {
      weekly = Math.min(6, Math.max(1, weekly + Number(b.dataset.pwD))); pw = weekly; applyFreq();
    }));
    applyFreq();
    if (!h) setTimeout(() => name.focus(), 350);
    const bad = (el) => { el.focus(); el.style.borderColor = '#FF8A80'; };
    sheet.querySelector('[data-save]').addEventListener('click', async () => {
      const n = name.value.trim();
      if (!n) return bad(name);
      const data = { id: h?.id, name: n, kind, perWeek: pw,
        note: sheet.querySelector('#f-note').value.trim(), askNote: ask.getAttribute('aria-checked') === 'true' };
      if (kind === 'count') {
        const tEl = sheet.querySelector('#f-target'), mEl = sheet.querySelector('#f-minamt');
        const target = parseNum(tEl.value);
        if (!target) return bad(tEl);
        let minAmount = parseNum(mEl.value);
        if (minAmount == null || minAmount <= 0) minAmount = Math.max(1, Math.round(target * 0.1));
        if (minAmount > target) return bad(mEl);
        Object.assign(data, { target, minAmount, unit: sheet.querySelector('#f-unit').value.trim() });
      } else {
        Object.assign(data, { full: sheet.querySelector('#f-full').value.trim(), min: '' });
      }
      await saveHabit(data);
      closeSheet();
      toast(h ? 'Збережено' : 'Звичку додано');
      rerenderAnimated();
    });
    const del = sheet.querySelector('[data-del]');
    if (del) {
      let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Точно видалити? Тапни ще раз'; return; }
        await deleteHabit(h.id);
        closeSheet();
        toast('Звичку видалено');
        rerenderAnimated();
      });
    }
  });
}
/* ===== Вікно «Скільки зроблено?» ===== */
function openAmountSheet(h, date, onDone) {
  const start = amt(h.id, date) ?? (val(h.id, date) === 2 ? h.target : val(h.id, date) === 1 ? minOf(h) : 0);
  let a = start;
  const u = h.unit ? ' ' + esc(h.unit) : '';
  const isToday = date === S.today;
  const dayLabel = isToday ? 'сьогодні' : fmtLong.format(parseKey(date));
  const step = h.target <= 10 ? 1 : h.target <= 60 ? 1 : 5;
  const minPos = Math.round(minOf(h) / h.target * 100);
  openSheet(`
    <h2>${esc(h.name)}</h2>
    <div class="amount-sub">Скільки зроблено ${esc(dayLabel)}?</div>
    <div class="amount-box">
      <button type="button" class="round-btn glass press" data-dec aria-label="Менше">−</button>
      <div class="amount-mid">
        <input class="amount-input" data-amount inputmode="decimal" value="${fmtNum(a)}" aria-label="Кількість" autocomplete="off">
        <div class="amount-of">з ${fmtNum(h.target)}${u}</div>
      </div>
      <button type="button" class="round-btn glass press" data-inc aria-label="Більше">+</button>
    </div>
    <div class="amount-track"><i data-fill></i><span class="min-mark" style="left:${minPos}%"></span></div>
    <div class="amount-status" data-status></div>
    <div class="quick">
      <button type="button" class="chip glass press" data-set="${minOf(h)}">Мінімум · ${fmtNum(minOf(h))}</button>
      <button type="button" class="chip glass press" data-set="${h.target}">Ціль · ${fmtNum(h.target)}</button>
      <button type="button" class="chip glass press" data-add="${step * 5}">+${step * 5}</button>
    </div>
    ${h.askNote ? `<div class="field"><label for="n-text">${INOTE}Як пройшло?</label>
      <textarea id="n-text" class="note-input" rows="3" maxlength="500" placeholder="${esc(notePlaceholder(h))}">${esc(noteOf(h.id, date))}</textarea></div>
      ${journalSwitchHTML(journalOnFor((markOf(h.id, date) || {}).jAt), date)}` : ''}
    <button class="btn primary block press" data-ok>Зберегти</button>
    <button class="btn block press" data-clear style="color:var(--muted)">Скинути</button>
  `, (sheet) => {
    const input = sheet.querySelector('[data-amount]');
    const noteEl = sheet.querySelector('#n-text');
    const paint = (fromInput = false) => {
      if (!fromInput) input.value = fmtNum(a);
      const v = valueForAmount(h, a);
      sheet.querySelector('[data-fill]').style.width = Math.min(100, a / h.target * 100) + '%';
      sheet.querySelector('[data-fill]').className = 'v' + v;
      const pct = Math.round(scoreOfAmount(h, a) * 100);
      sheet.querySelector('[data-status]').innerHTML = v === 2 ? `<b class="ok">Ціль виконано</b> · 100% дня для звички`
        : v === 1 ? `<b class="ok">${a > minOf(h) ? 'Зараховано' : 'Мінімум зараховано'}</b> · ${pct}% · до цілі ще ${fmtNum(h.target - a)}`
        : a > 0 ? `Ще ${fmtNum(minOf(h) - a)} до мінімуму` : 'Ще не відмічено';
    };
    const set = (n) => { a = Math.max(0, Math.round(n * 10) / 10); paint(); };
    sheet.querySelector('[data-dec]').addEventListener('click', () => set(a - step));
    sheet.querySelector('[data-inc]').addEventListener('click', () => set(a + step));
    sheet.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => set(Number(b.dataset.set))));
    sheet.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => set(a + Number(b.dataset.add))));
    input.addEventListener('focus', () => input.select());
    input.addEventListener('input', () => { const n = parseNum(input.value); a = n ?? 0; paint(true); });
    const save = async (value) => {
      const jOn = journalSwitchOn(sheet);
      await setMark(h.id, date, valueForAmount(h, value), value > 0 ? value : null, noteEl ? noteEl.value.trim() : undefined,
        noteEl ? journalStamp(jOn, (markOf(h.id, date) || {}).jAt) : undefined);
      closeSheet();
      if (onDone) onDone();
    };
    sheet.querySelector('[data-ok]').addEventListener('click', () => save(a));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(a); });
    sheet.querySelector('[data-clear]').addEventListener('click', () => save(0));
    paint();
  });
}
/* ===== Нотатка дня до звички ===== */
const notePlaceholder = () => 'Що вдалось, що завадило, як почуваєшся…';
function openNoteSheet(h, date, { afterMark = false } = {}) {
  const v = val(h.id, date);
  const label = v === 2 ? 'Виконано' : v === 1 ? 'Мінімум' : 'Не відмічено';
  openSheet(`
    <h2>${esc(h.name)}</h2>
    <div class="amount-sub">${esc(date === S.today ? 'Сьогодні' : fmtLong.format(parseKey(date)))} · <b class="${v ? 'ok' : ''}">${label}</b></div>
    ${h.note ? `<div class="habit-note-box">${INOTE}<span>${esc(h.note)}</span></div>` : ''}
    <label for="n-text" class="sr-only">Нотатка за день</label>
    <textarea id="n-text" class="note-input big" rows="5" maxlength="500" placeholder="${afterMark ? 'Як пройшло? ' : ''}${esc(notePlaceholder(h))}">${esc(noteOf(h.id, date))}</textarea>
    ${journalSwitchHTML(journalOnFor((markOf(h.id, date) || {}).jAt), date)}
    <div class="row-actions">
      <button class="btn block glass press" data-skip>${afterMark ? 'Пропустити' : 'Скасувати'}</button>
      <button class="btn primary block press" data-ok>Зберегти</button>
    </div>
  `, (sheet) => {
    const ta = sheet.querySelector('#n-text');
    setTimeout(() => ta.focus(), 350);
    sheet.querySelector('[data-skip]').addEventListener('click', () => closeSheet());
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const jOn = journalSwitchOn(sheet);
      await setMark(h.id, date, val(h.id, date), undefined, ta.value.trim(), journalStamp(jOn, (markOf(h.id, date) || {}).jAt));
      closeSheet();
      toast(noteToast(ta.value.trim(), jOn));
      const row = currentView()?.querySelector(`.habit[data-id="${h.id}"]`);
      if (row) updateTodayDynamic(row); else rerender();
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sheet.querySelector('[data-ok]').click(); });
  });
}
function recentNotesHTML(h) {
  const list = [...S.marks.entries()]
    .filter(([k, m]) => k.startsWith(h.id + '|') && m.note)
    .map(([k, m]) => ({ date: k.split('|')[1], note: m.note, value: m.value }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  if (!list.length) return '';
  return `<div class="field"><label>Останні нотатки</label><div class="notes-list">${list.map((n) =>
    `<button type="button" class="note-item glass" data-note-day="${n.date}"><small>${esc(fmtWdShortDate.format(parseKey(n.date)))}</small><span>${esc(n.note)}</span></button>`).join('')}</div></div>`;
}

function scoreOfAmount(h, a) {
  const t = h.target, mn = minOf(h);
  if (a >= t) return 1;
  if (a < mn || a <= 0) return 0;
  return t === mn ? 1 : 0.5 + 0.5 * (a - mn) / (t - mn);
}

function rerenderAnimated() {
  const el = currentView();
  if (!el) return;
  el.classList.remove('enter', 'static');
  renderView(el);
}

function syncText() {
  const s = S.sync;
  const when = s.lastSync ? ' · ' + fmtTime.format(new Date(s.lastSync)) : '';
  if (s.state === 'offline') return s.pending ? `Офлайн. ${s.pending} ${plural(s.pending, 'зміну', 'зміни', 'змін')} збережено на телефоні — відправлю, щойно з'явиться інтернет.` : 'Офлайн. Усе збережено на телефоні.';
  if (s.state === 'syncing') return 'Синхронізую…';
  if (s.state === 'error') return `Не вдалося з'єднатися з сервером. Дані на телефоні, спробую ще раз.`;
  if (s.state === 'synced') return 'Усе збережено в хмарі' + when;
  return 'Дані збережено на телефоні' + when;
}

/* ===== Резервна копія: усе в один файл і назад ===== */
const BACKUP_STORES = ['habits', 'marks', 'tasks', 'journal', 'sleep'];
async function exportBackup() {
  const data = {};
  for (const st of BACKUP_STORES) data[st] = (await db.getAll(st)).map(({ dirty, ...r }) => r);
  const json = JSON.stringify({ app: 'zvychky', version: 1, exportedAt: new Date().toISOString(), data });
  const name = `zvychky-${S.today}.json`;
  const file = new File([json], name, { type: 'application/json' });
  await db.setMeta('lastBackup', Date.now());
  // на iPhone — меню «Поділитися» (Зберегти у Файли, AirDrop, Telegram…), на компʼютері — завантаження
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Звички — резервна копія' }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return 'downloaded';
}
async function importBackup(file) {
  const parsed = JSON.parse(await file.text());
  if (!parsed || parsed.app !== 'zvychky' || !parsed.data) throw new Error('Це не файл копії «Звичок»');
  const now = Date.now();
  let n = 0;
  for (const st of BACKUP_STORES) {
    const list = Array.isArray(parsed.data[st]) ? parsed.data[st] : [];
    // свіжий updatedAt — щоб відновлене перемогло й на сервері, і на інших пристроях
    await db.putMany(st, list.filter((r) => r && (r.id || r.k)).map((r) => ({ ...r, updatedAt: now, dirty: true })));
    n += list.length;
  }
  return n;
}

async function openSettings() {
  const ns = await getNotifySettings();
  const lastBackup = await db.getMeta('lastBackup', null);
  const uid = await getUserId();
  const needInstall = isIOS() && !isStandalone();
  openSheet(`
    <h2>Налаштування</h2>
    <div class="gh">Нагадування</div>
    <div class="set-group">
      <div class="set-row"><div class="l"><b>Про звички</b><span>${needInstall ? 'Спершу встанови застосунок на початковий екран' : 'Якщо до цього часу не все відмічено'}</span></div>
        <button class="switch" role="switch" aria-checked="${ns.enabled && ns.daily}" aria-label="Нагадування про звички" data-notify></button></div>
      <div class="set-row"><div class="l"><b>Час</b></div><input type="time" value="${esc(ns.time)}" data-time aria-label="Час нагадування"></div>
      <button class="set-row link" data-sleep-entry><div class="l"><b>Режим сну</b><span>${S.sleepCfg && S.sleepCfg.active ? 'Програма йде · тиждень ' + ((stageOn(S.sleepCfg, S.today) || { week: -1 }).week + 1) : '4 тижні, щоб засинати й вставати раніше'}</span></div>${I.right}</button>
    </div>
    <div class="gh">Дані</div>
    <div class="set-group">
      <div class="set-row"><div class="l"><b>Резервна копія</b><span>${lastBackup ? 'Остання — ' + esc(fmtDayMonth.format(new Date(lastBackup))) : 'Ще не робив'}</span></div>
        <button class="small-btn press" data-backup>Зберегти</button></div>
      <div class="set-row"><div class="l"><b>Відновити з файлу</b><span>Записи з файлу замінять ті самі записи тут</span></div>
        <label class="small-btn press" style="display:inline-flex;align-items:center">Вибрати<input type="file" accept="application/json,.json" data-restore hidden></label></div>
      <div class="set-row"><div class="l"><b>Синхронізація</b><span data-sync-text>${esc(syncText())}</span></div>
        <button class="small-btn press" data-sync-now>Зараз</button></div>
      <div class="set-row"><div class="l"><b>Код синхронізації</b><span class="code">${esc(uid)}</span></div>
        <button class="small-btn press" data-copy>Копіювати</button></div>
      <div class="set-row"><div class="l" style="flex:1"><b>Підключити інший пристрій</b><span>Встав код з іншого телефона</span></div></div>
      <div class="set-row" style="padding-top:0"><input class="code-in" data-code placeholder="u-…" style="flex:1;min-width:0;min-height:40px;padding:0 12px;border-radius:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);font-size:16px" autocomplete="off" autocapitalize="off"><button class="small-btn press" data-adopt>Підключити</button></div>
    </div>
    <div class="gh">Про застосунок</div>
    <div class="set-group">
      <button class="set-row link" data-intro><div class="l"><b>Що вміє застосунок</b><span>Коротка презентація</span></div>${I.right}</button>
    </div>
    <button class="btn block press glass" data-close>Готово</button>
  `, (sheet) => {
    const sw = sheet.querySelector('[data-notify]');
    const time = sheet.querySelector('[data-time]');
    sw.addEventListener('click', async () => {
      const on = sw.getAttribute('aria-checked') === 'true';
      try {
        if (on) { await setDaily(false, time.value || '20:00'); sw.setAttribute('aria-checked', 'false'); toast('Нагадування про звички вимкнено'); }
        else { await setDaily(true, time.value || '20:00'); sw.setAttribute('aria-checked', 'true'); toast('Нагадаю о ' + (time.value || '20:00')); }
      } catch (e) { toast(e.message || 'Не вдалося'); }
    });
    time.addEventListener('change', async () => {
      try { const s = await updateTime(time.value); if (s.enabled && s.daily) toast('Нагадаю о ' + time.value); } catch (e) { toast(e.message); }
    });
    sheet.querySelector('[data-sleep-entry]').addEventListener('click', () => {
      if (S.sleepCfg && S.sleepCfg.active) { closeSheet(); showTab('sleep'); } else openSleepSetup();
    });
    sheet.querySelector('[data-intro]').addEventListener('click', () => { closeSheet(); setTimeout(openIntro, 250); });
    sheet.querySelector('[data-backup]').addEventListener('click', async () => {
      try { const r = await exportBackup(); if (r !== 'cancel') toast(r === 'shared' ? 'Копію створено' : 'Файл копії завантажено'); }
      catch (e) { toast('Не вдалося створити копію'); }
    });
    sheet.querySelector('[data-restore]').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!confirm('Відновити дані з «' + f.name + '»?')) { e.target.value = ''; return; }
      try {
        const n = await importBackup(f);
        await loadState(); await generateInstances();
        closeSheet(); toast(`Відновлено записів: ${n}`);
        rerenderAnimated(); scheduleSync(300);
      } catch (err) { toast(err.message || 'Файл не підходить'); }
      e.target.value = '';
    });
    sheet.querySelector('[data-sync-now]').addEventListener('click', () => syncNow({ onMerged: onServerMerge }));
    sheet.querySelector('[data-copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(uid); toast('Код скопійовано'); } catch (e) { toast('Не вдалося скопіювати'); }
    });
    sheet.querySelector('[data-adopt]').addEventListener('click', async () => {
      try {
        await adoptUserId(sheet.querySelector('[data-code]').value);
        closeSheet();
        toast('Підключено. Синхронізую…');
        await syncNow({ onMerged: onServerMerge });
        await loadState();
        rerenderAnimated();
      } catch (e) { toast(e.message || 'Не вдалося'); }
    });
  });
}

/* ================= Тости та конфеті ================= */
let toastTimer = null;
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}
function confetti(fromEl) {
  if (reduceMotion()) return;
  const fx = document.getElementById('fx');
  const r = fromEl ? fromEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 3, width: 0, height: 0 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const colors = ['#D4F57A', '#F2F4F7', '#8B74FF', '#3FD6C6', '#E8FFB0'];
  for (let i = 0; i < 46; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    s.style.left = cx + 'px'; s.style.top = cy + 'px';
    s.style.background = colors[i % colors.length];
    if (i % 3 === 0) s.style.borderRadius = '50%';
    fx.appendChild(s);
    const ang = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 160;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 60;
    s.animate([
      { transform: 'translate(-50%,-50%) scale(1) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 140}px)) scale(.6) rotate(${Math.random() * 720 - 360}deg)`, opacity: 0 }
    ], { duration: 900 + Math.random() * 600, easing: 'cubic-bezier(.15,.8,.3,1)', fill: 'forwards' }).onfinish = () => s.remove();
  }
}
function ripple(row, e) {
  if (reduceMotion()) return;
  const r = row.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const d = document.createElement('span');
  d.className = 'ripple';
  d.style.width = d.style.height = size + 'px';
  d.style.left = ((e?.clientX ?? r.left + r.width - 30) - r.left - size / 2) + 'px';
  d.style.top = ((e?.clientY ?? r.top + r.height / 2) - r.top - size / 2) + 'px';
  row.appendChild(d);
  setTimeout(() => d.remove(), 750);
}
function popEl(el) {
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

/* ================= Планувальник ================= */
const fmtWdShortDate = new Intl.DateTimeFormat('uk', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShortDM = new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'short' });
const ICAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
const IBELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
const INOTE = '<svg class="i-note" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
const ISUN = '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const IREPEAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>';
const ICLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

const relDay = (d) => (d === S.today ? 'Сьогодні' : d === addDays(S.today, 1) ? 'Завтра' : d === addDays(S.today, -1) ? 'Вчора' : cap(fmtWeekday.format(parseKey(d))));
const onDay = (d) => (d === S.today ? 'на сьогодні' : d === addDays(S.today, 1) ? 'на завтра' : 'на ' + fmtDayMonth.format(parseKey(d)));
const chipDay = (d) => (d === S.today ? 'Сьогодні' : d === addDays(S.today, 1) ? 'Завтра' : `${WD_SHORT[parseKey(d).getDay()]}, ${parseKey(d).getDate()}`);
const tasksOn = (d) => S.tasks.filter((t) => t.date === d);
// Невиконане з минулих днів автоматично показується в «Сьогодні» як «Перенесено»
const carriedTasks = () => S.tasks.filter((t) => t.date < S.today && !t.done && !t.rule).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
const timeRange = (t) => (t.time ? t.time + (t.endTime ? '–' + t.endTime : '') : '');
// коли нагадати: точний час; старі завдання без remindAt — за 15 хв до початку
const remindAtOf = (t) => (!t.remind ? '' : t.remindAt || (t.time ? minusMin(t.time, 15) : ''));
const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const isNow = (t) => t.date === S.today && t.time && t.endTime && !t.done && nowHM() >= t.time && nowHM() < t.endTime;
const byTime = (a, b) => ((a.time || '99') < (b.time || '99') ? -1 : (a.time || '99') > (b.time || '99') ? 1 : a.order - b.order);
function dayState(d) {
  const l = tasksOn(d);
  if (!l.length) return null;
  const open = l.filter((t) => !t.done).length;
  // важливе (Appointment, подія) — червона крапка; минулі виконані важливі вже не горять
  const imp = l.some((t) => t.important && (!t.done || d >= S.today));
  return { total: l.length, open, imp, cls: imp ? 'imp' : !open ? 'done' : d < S.today ? 'late' : 'open' };
}

/* ===== Повторювані завдання =====
   Правило (repeat = дні тижня) зберігається окремо, а на кожен день створюється звичайна копія
   з передбачуваним id (правило + дата) — тому два пристрої не створять дублікатів. */
function isRule(t) { return Array.isArray(t.repeat) && t.repeat.length > 0; }
const RULE_AHEAD = 30; // на скільки днів уперед створювати копії (сервер нагадує саме про них)
const instId = (ruleId, d) => ruleId + 'r' + d.replace(/-/g, '');
const RULE_FIELDS = ['title', 'time', 'endTime', 'remind', 'remindAt', 'note', 'askNote', 'important'];
const pickRule = (o) => Object.fromEntries(RULE_FIELDS.map((k) => [k, o[k]]));
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
function repeatLabel(days) {
  const d = [...days].sort();
  if (d.length === 7) return 'щодня';
  if (d.join() === '1,2,3,4,5') return 'по буднях';
  if (d.join() === '0,6') return 'на вихідних';
  return 'щотижня: ' + WD_ORDER.filter((x) => d.includes(x)).map((x) => WD_SHORT[x].toLowerCase()).join(', ');
}
async function generateInstances() {
  const end = addDays(S.today, RULE_AHEAD);
  const recs = [];
  for (const r of S.rules) {
    for (let d = r.date > S.today ? r.date : S.today; d <= end; d = addDays(d, 1)) {
      if (r.until && d > r.until) break;
      if (!r.repeat.includes(parseKey(d).getDay())) continue;
      const id = instId(r.id, d);
      if (S.taskIds.has(id)) continue;
      // updatedAt: 1 — «найстаріший», тож будь-яка справжня зміна чи видалення з іншого пристрою переможе
      const t = { id, ...pickRule(r), date: d, done: false, doneNote: '', jAt: 0, rule: r.id, repeat: [],
        order: r.order || 0, createdAt: Date.now(), updatedAt: 1, deleted: false, dirty: true };
      recs.push(t); S.tasks.push(t); S.taskIds.add(id);
    }
  }
  if (recs.length) { await db.putMany('tasks', recs.map((t) => ({ ...t }))); scheduleSync(); }
}
async function putRule(r) {
  Object.assign(r, { updatedAt: Date.now(), dirty: true });
  await db.put('tasks', { ...r });
  S.taskIds.add(r.id);
  if (r.deleted) S.rules = S.rules.filter((x) => x.id !== r.id);
  else if (!S.rules.includes(r)) S.rules.push(r);
  scheduleSync();
}
async function createRule(fields) {
  const now = Date.now();
  const maxOrder = S.tasks.concat(S.rules).reduce((m, x) => Math.max(m, x.order || 0), 0);
  const r = { id: 't-' + now.toString(36) + Math.random().toString(36).slice(2, 7), ...fields, done: false, doneNote: '', jAt: 0,
    rule: '', until: '', order: maxOrder + 1, createdAt: now, createdOn: S.today, deleted: false };
  await putRule(r);
  await generateInstances();
  return r;
}
// Змінити серію: правило + усі невиконані копії від дати from
async function updateRule(rule, fields, from, exceptId) {
  Object.assign(rule, fields);
  if (rule.date > from) rule.date = from;
  await putRule(rule);
  for (const t of S.tasks.filter((x) => x.rule === rule.id && x.date >= from && !x.done && x.id !== exceptId)) {
    if (!rule.repeat.includes(parseKey(t.date).getDay())) await patchTask(t.id, { deleted: true });
    else await patchTask(t.id, pickRule(rule));
  }
  await generateInstances();
}
// Зупинити серію: копії від дати from видаляються, правило — теж
async function endRule(rule, from, keepId) {
  for (const t of S.tasks.filter((x) => x.rule === rule.id && x.date >= from && !x.done && x.id !== keepId)) await patchTask(t.id, { deleted: true });
  rule.deleted = true;
  await putRule(rule);
}

async function saveTask(data) {
  const now = Date.now();
  let t = data.id ? S.tasks.find((x) => x.id === data.id) : null;
  const time = data.time || '';
  const endTime = time && data.endTime && data.endTime > time ? data.endTime : '';
  const remindAt = data.remind ? data.remindAt || '' : '';
  const fields = { title: data.title, date: data.date, time, endTime, remind: !!remindAt, remindAt,
    note: (data.note || '').slice(0, 500), askNote: !!data.askNote, important: !!data.important };
  if (t) {
    Object.assign(t, fields, { updatedAt: now, dirty: true });
  } else {
    const maxOrder = S.tasks.reduce((m, x) => Math.max(m, x.order || 0), 0);
    t = { id: 't-' + now.toString(36) + Math.random().toString(36).slice(2, 7), ...fields, done: false,
      order: maxOrder + 1, createdAt: now, updatedAt: now, deleted: false, dirty: true };
    S.tasks.push(t);
  }
  await db.put('tasks', { ...t });
  scheduleSync();
  return t;
}
async function patchTask(id, patch) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch, { updatedAt: Date.now(), dirty: true });
  await db.put('tasks', { ...t });
  if (t.deleted) S.tasks = S.tasks.filter((x) => x.id !== id);
  scheduleSync();
  return t;
}

function planHead(eyebrow, title) {
  return headHTML({ eyebrow: cap(eyebrow), title }) + segHTML([['day', 'День'], ['ahead', 'Наперед'], ['cal', 'Календар']], S.planMode, 'plan-mode', 'Вигляд плану');
}

// нотатка під назвою: після виконання — «як пройшло», інакше — опис завдання
function noteLine(t, compact) {
  const txt = t.done && t.doneNote ? t.doneNote : t.note;
  if (!txt) return '';
  return `<span class="tn${t.done && t.doneNote ? ' res' : ''}${compact ? ' compact' : ''}">${INOTE}${esc(txt)}</span>`;
}
function taskRow(t, i, { carried = false, compact = false } = {}) {
  const meta = carried && t.date !== addDays(S.today, -1) ? 'з ' + fmtShortDM.format(parseKey(t.date)) : '';
  const now = isNow(t);
  const rem = remindAtOf(t);
  const sub = meta || (now ? 'Зараз · до ' + t.endTime : '');
  return `<div class="task${compact ? ' compact' : ' glass'}${t.important ? ' imp' : ''}${t.done ? ' done' : ''}${carried ? ' late' : ''}${now ? ' now' : ''}" data-task="${t.id}" style="--i:${i}">
    <button class="tcheck" data-act="task-toggle" data-id="${t.id}" aria-label="${t.done ? 'Зняти позначку' : 'Виконано'}: ${esc(t.title)}">${I.check}</button>
    <button class="tbody" data-act="task-edit" data-id="${t.id}" aria-label="Змінити: ${esc(t.title)}">
      <span class="tt">${t.important ? '<i class="impdot" aria-label="Важливе"></i>' : ''}${esc(t.title)}${t.rule ? `<i class="trep" aria-label="Повторюється">${IREPEAT}</i>` : ''}</span>${sub ? `<span class="tm${meta ? '' : ' soft'}">${esc(sub)}</span>` : ''}
      ${noteLine(t, compact)}
    </button>
    ${t.askNote ? `<button class="tnote${t.doneNote ? ' has' : ''}" data-act="task-note" data-id="${t.id}" aria-label="Нотатка: ${esc(t.title)}">${INOTE}</button>` : ''}
    ${t.time || rem ? `<span class="ttime${t.endTime && !now ? ' range' : ''}">${rem && !t.done ? IBELL : ''}${now ? t.time : timeRange(t) || rem}</span>` : ''}
  </div>`;
}

function renderPlan(el) {
  if (S.planMode === 'ahead') renderPlanAhead(el);
  else if (S.planMode === 'cal') renderPlanCal(el);
  else renderPlanDay(el);
  updatePlanBar();
}

function renderPlanDay(el) {
  const date = S.planDate;
  const start = date >= S.today && date <= addDays(S.today, 6) ? S.today : date;
  const strip = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const st = dayState(d);
    strip.push(`<button class="pday${d === date ? ' sel' : ''}${d === S.today ? ' today' : ''}" data-act="plan-day" data-date="${d}" aria-label="${esc(fmtLong.format(parseKey(d)))}${st ? ', завдань: ' + st.total : ''}">
      <span class="wd">${WD_SHORT[parseKey(d).getDay()]}</span><span class="dn">${parseKey(d).getDate()}</span><i class="dot ${st ? st.cls : ''}"></i></button>`);
  }
  const list = tasksOn(date);
  const carried = date === S.today ? carriedTasks() : [];
  const timed = list.filter((t) => t.time).sort(byTime);
  const any = list.filter((t) => !t.time).sort((a, b) => a.order - b.order);
  const total = carried.length + list.length;
  const done = list.filter((t) => t.done).length;
  let i = 0;
  const section = (title, items, opts = {}) => (items.length
    ? `<div class="tsec">${title ? `<div class="tsec-h">${title}</div>` : ''}${items.map((t) => taskRow(t, i++, opts)).join('')}</div>` : '');

  const lateLabel = carried.every((t) => t.date === addDays(S.today, -1)) ? 'З учора' : 'Не зроблено раніше';
  el.innerHTML = `
    ${planHead(fmtLong.format(parseKey(date)), relDay(date))}
    <div class="cols">
    <div class="col">
    <div class="pstrip">${strip.join('')}</div>
    ${total ? `<div class="pprog"><span>${done} з ${total} зроблено</span><div class="pbar"><i style="width:${Math.round(done / total * 100)}%"></i></div></div>` : ''}
    <div class="stagger tlist">
      ${section(lateLabel, carried, { carried: true })}
      ${section(carried.length ? relDay(date) : '', timed.concat(any))}
    </div>
    ${total ? '' : `<div class="empty glass">${ISUN}<h2>${date < S.today ? 'Нічого не було' : 'Вільний день'}</h2><p>${date < S.today ? 'На цей день справ не планувалось.' : 'На цей день ще нічого не заплановано. Додай завдання знизу.'}</p></div>`}
    </div>
    <div class="col side-only sticky">${calCardHTML(date)}${nextCardHTML()}</div>
    </div>`;
}

function renderPlanAhead(el) {
  const carried = carriedTasks();
  // повторювані показуємо лише на тиждень уперед, щоб щоденні не заполонили список
  const weekEnd = addDays(S.today, 6);
  const dates = [...new Set(S.tasks.filter((t) => t.date >= S.today && (!t.rule || t.date <= weekEnd)).map((t) => t.date))].sort();
  if (carried.length && !dates.includes(S.today)) dates.unshift(S.today);
  let i = 0;
  const groups = dates.slice(0, 40).map((d, gi) => {
    const items = (d === S.today ? carried : []).concat(tasksOn(d).filter((t) => !t.rule || d <= weekEnd).sort(byTime));
    const open = items.filter((t) => !t.done).length;
    const sub = d === S.today || d === addDays(S.today, 1) ? fmtWdShortDate.format(parseKey(d)) : fmtDayMonth.format(parseKey(d));
    return `<div class="tgroup glass" style="--i:${gi}">
      <div class="tgroup-h">${items.some((t) => t.important && !t.done) ? '<i class="impdot" aria-label="Є важливе"></i>' : ''}<b class="${d === S.today ? 'lime' : ''}">${relDay(d)}</b><span>${esc(sub)}</span><em>${open ? open + ' ' + plural(open, 'справа', 'справи', 'справ') : 'усе ✓'}</em></div>
      ${items.map((t) => taskRow(t, i++, { carried: t.date < S.today, compact: true })).join('')}
    </div>`;
  }).join('');
  const last = dates.length ? dates[Math.min(dates.length, 40) - 1] : null;
  el.innerHTML = `
    ${planHead(last && last !== S.today ? `${fmtShortDM.format(parseKey(S.today))} – ${fmtShortDM.format(parseKey(last))}` : 'Найближчі справи', 'Наперед')}
    ${groups ? `<div class="stagger tgroups">${groups}</div>`
      : `<div class="empty glass">${ISUN}<h2>Наперед порожньо</h2><p>Додай завдання на будь-який день — вони з'являться тут списком по днях.</p></div>`}`;
}

function calCardHTML(sel = null) {
  const t0 = parseKey(S.today);
  const first = new Date(t0.getFullYear(), t0.getMonth() + S.calOffset, 1);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  let busy = 0, total = 0;
  const cells = [];
  for (let k = 0; k < offset; k++) cells.push('<div></div>');
  for (let n = 1; n <= days; n++) {
    const d = keyOf(new Date(first.getFullYear(), first.getMonth(), n));
    const st = dayState(d);
    if (st) { busy++; total += st.total; }
    const base = st ? (!st.open ? 'done' : d < S.today ? 'late' : 'open') : '';
    const dots = st ? Array.from({ length: Math.min(3, st.total) }, (_, k) => `<i class="${k === 0 && st.imp ? 'imp' : base}"></i>`).join('') : '';
    cells.push(`<button class="ccell${st ? ' has' : ''}${st && st.imp ? ' imp' : ''}${d === S.today ? ' today' : ''}${d < S.today ? ' past' : ''}${d === sel ? ' sel' : ''}" data-act="plan-open" data-date="${d}" aria-label="${esc(fmtLong.format(parseKey(d)))}${st ? ', завдань: ' + st.total : ', вільно'}">
      <span>${n}</span><span class="cdots">${dots}</span></button>`);
  }
  const monthName = cap(new Intl.DateTimeFormat('uk', { month: 'long' }).format(first));
  return `<div class="calcard glass">
      <div class="cal-nav">
        <button class="icon-btn small press" data-act="cal-nav" data-d="-1" aria-label="Попередній місяць">${I.left}</button>
        <span><b>${monthName} ${first.getFullYear()}</b></span>
        <button class="icon-btn small press" data-act="cal-nav" data-d="1" aria-label="Наступний місяць">${I.right}</button>
      </div>
      <div class="cgrid wds"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span class="we">Сб</span><span class="we">Нд</span></div>
      <div class="cgrid">${cells.join('')}</div>
    </div>`;
}
const monthsFromToday = (d) => { const p = parseKey(d), n = parseKey(S.today); return (p.getFullYear() - n.getFullYear()) * 12 + p.getMonth() - n.getMonth(); };
const legendHTML = () => '<div class="legend"><span><i class="l-open"></i>Заплановано</span><span><i class="l-late"></i>Не виконано</span><span><i class="l-done"></i>Усе зроблено</span><span><i class="l-imp"></i>Важливе</span></div>';
function nextCardHTML() {
  const upcoming = S.tasks.filter((t) => !t.done && t.date >= S.today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byTime(a, b)))[0];
  return upcoming ? `<button class="nextcard glass press" data-act="plan-open" data-date="${upcoming.date}">
      <span class="nc-date"><small>${WD_SHORT[parseKey(upcoming.date).getDay()]}</small><b>${parseKey(upcoming.date).getDate()}</b></span>
      <span class="nc-txt"><small>Найближче · ${esc(relDay(upcoming.date).toLowerCase())}</small><b>${upcoming.time ? timeRange(upcoming) + ' · ' : ''}${esc(upcoming.title)}</b></span>
      ${I.right}</button>` : '';
}

function renderPlanCal(el) {
  const t0 = parseKey(S.today);
  const first = new Date(t0.getFullYear(), t0.getMonth() + S.calOffset, 1);
  const sel = S.planDate;
  const list = tasksOn(sel).sort(byTime);
  const busy = new Set(S.tasks.filter((t) => t.date.startsWith(keyOf(first).slice(0, 7))).map((t) => t.date)).size;
  el.innerHTML = `
    ${planHead(busy ? `${busy} ${plural(busy, 'день', 'дні', 'днів')} зі справами` : 'Справ поки немає', cap(new Intl.DateTimeFormat('uk', { month: 'long' }).format(first)))}
    <div class="cols">
      <div class="col">${calCardHTML(sel)}</div>
      <div class="col sticky">
        <div class="tsec-h">${esc(cap(fmtLong.format(parseKey(sel))))}</div>
        <div class="stagger tlist">${list.length ? list.map((t, i) => taskRow(t, i)).join('') : `<div class="calfree">${sel < S.today ? 'Справ не було' : 'Вільний день'}</div>`}</div>
      </div>
    </div>`;
}

// Поле «Додати…» над меню
const planBar = document.createElement('button');
planBar.className = 'planbar';
planBar.innerHTML = '<span data-l>Додати завдання…</span><i>' + I.plus + '</i>';
document.getElementById('app').appendChild(planBar);
planBar.addEventListener('click', () => openTaskSheet(null, S.planMode === 'day' ? S.planDate : S.today));
function updatePlanBar() {
  const d = S.planMode === 'day' ? S.planDate : null;
  planBar.querySelector('[data-l]').textContent = d && d >= S.today ? `Додати ${onDay(d)}…` : 'Додати завдання…';
}

function openTaskSheet(task = null, date = S.today) {
  let sel = task ? task.date : (date < S.today ? S.today : date);
  let time = task ? task.time || '' : '';
  let endTime = task ? task.endTime || '' : '';
  // нагадування: 'off' | хвилин до початку (0, 5, 15…) | 'custom' (свій точний час)
  const OFFSETS = [[0, 'На початку'], [5, 'за 5 хв'], [15, 'за 15 хв'], [30, 'за 30 хв'], [60, 'за 1 год'], [120, 'за 2 год']];
  const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  let remMode = 'off';
  let remAt = '';
  if (task && task.remind) {
    remAt = remindAtOf(task);
    const off = time && remAt ? toMin(time) - toMin(remAt) : null;
    remMode = OFFSETS.some(([m]) => m === off) ? off : 'custom';
  }
  const remindTime = () => (remMode === 'off' ? '' : remMode === 'custom' ? remAt : time ? minusMin(time, remMode) : '');
  const t0 = parseKey(S.today);
  const monthOff = (d) => { const p = parseKey(d); return (p.getFullYear() - t0.getFullYear()) * 12 + p.getMonth() - t0.getMonth(); };
  let calOff = Math.max(0, monthOff(sel));
  const nextMon = addDays(S.today, 7 - ((t0.getDay() + 6) % 7));
  const chipDates = [S.today, addDays(S.today, 1), addDays(S.today, 2)];
  const rule = task && task.rule ? S.rules.find((r) => r.id === task.rule) : null;
  let rep = rule ? [...rule.repeat] : [];
  const repMode = () => {
    const d = [...rep].sort().join();
    if (!rep.length) return 'none';
    if (rep.length === 7) return 'daily';
    if (d === '1,2,3,4,5') return 'weekdays';
    if (rep.length === 1 && rep[0] === parseKey(sel).getDay()) return 'weekly';
    return 'custom';
  };
  let repCustom = repMode() === 'custom';

  openSheet(`
    <h2>${task ? 'Змінити завдання' : 'Нове завдання'}</h2>
    <label for="t-title" class="sr-only">Що треба зробити</label>
    <input id="t-title" class="big-input" maxlength="120" placeholder="Що треба зробити?" value="${esc(task ? task.title : '')}" autocomplete="off">
    <div class="dchips" data-chips></div>
    <div class="mcal" data-cal hidden></div>
    <div class="set-group opts">
      <div class="set-row trow"><div class="l"><b>${ICLOCK}Час</b></div><div class="timerow" data-timerow></div></div>
      <small class="warn" data-timehint></small>
      <button type="button" class="set-row link" data-open="rem"><div class="l"><b>${IBELL}Нагадування</b></div><span class="v" data-rem-v></span>${I.right}</button>
      <div class="sbody" data-body="rem" hidden><div class="dchips rem" data-remchips></div><div class="remcustom" data-remcustom></div><small data-remhint></small></div>
      <button type="button" class="set-row link" data-open="rep"><div class="l"><b>${IREPEAT}Повторювати</b></div><span class="v" data-rep-v></span>${I.right}</button>
      <div class="sbody" data-body="rep" hidden><div class="dchips" data-repchips></div><div class="wdpick" data-wdpick></div><small data-rephint></small></div>
      <button type="button" class="set-row link" data-open="note"><div class="l"><b>${INOTE}Нотатка</b></div><span class="v" data-note-v>${task?.note ? '' : 'Додати'}</span>${I.right}</button>
      <div class="sbody" data-body="note" ${task?.note ? '' : 'hidden'}><textarea id="t-note" class="note-input" rows="2" maxlength="500" placeholder="Деталі, адреса, що взяти з собою…">${esc(task?.note || '')}</textarea></div>
    </div>
    <div class="set-group">
      <div class="set-row"><div class="l"><b><i class="impdot"></i>Важливе</b></div>
        <button type="button" class="switch red" role="switch" aria-checked="${!!task?.important}" aria-label="Важливе" data-important></button></div>
      <div class="set-row"><div class="l"><b>Спитати «Як пройшло?»</b></div>
        <button type="button" class="switch" role="switch" aria-checked="${!!task?.askNote}" aria-label="Питати нотатку при виконанні" data-asknote></button></div>
    </div>
    ${task?.doneNote ? `<div class="field"><label>Як пройшло</label><button type="button" class="note-item glass" data-open-result><span>${esc(task.doneNote)}</span></button></div>` : ''}
    <button class="btn primary block press" data-save></button>
    ${task ? `<div class="row-actions">${task.done ? '' : `<button class="btn block glass press" data-tomorrow>На завтра</button>`}<button class="btn danger block press" data-del>Видалити</button></div>` : ''}
  `, (sheet) => {
    const title = sheet.querySelector('#t-title');
    const ask = sheet.querySelector('[data-asknote]');
    ask.addEventListener('click', () => ask.setAttribute('aria-checked', ask.getAttribute('aria-checked') !== 'true'));
    const imp = sheet.querySelector('[data-important]');
    imp.addEventListener('click', () => imp.setAttribute('aria-checked', imp.getAttribute('aria-checked') !== 'true'));
    sheet.querySelector('[data-open-result]')?.addEventListener('click', () => openTaskNoteSheet(task));
    // Перемальовуємо частинами: поля часу НЕ чіпаємо, поки людина в них друкує,
    // інакше на компʼютері курсор вилітає з поля після першої цифри.
    const paint = () => { paintDates(); paintTime(); paintRem(true); paintRep(); };
    const paintRep = () => {
      const m = repCustom ? 'custom' : repMode();
      const wd = WD_SHORT[parseKey(sel).getDay()].toLowerCase();
      sheet.querySelector('[data-repchips]').innerHTML = [['none', 'Ні'], ['daily', 'Щодня'], ['weekdays', 'Будні'], ['weekly', 'Щотижня (' + wd + ')'], ['custom', 'Свої дні']]
        .map(([k, l]) => `<button type="button" class="chip glass${m === k ? ' on' : ''}" data-rep="${k}" aria-pressed="${m === k}">${l}</button>`).join('');
      sheet.querySelector('[data-wdpick]').innerHTML = m === 'custom' ? WD_ORDER.map((d) =>
        `<button type="button" class="wd${rep.includes(d) ? ' on' : ''}" data-wd="${d}" aria-pressed="${rep.includes(d)}">${WD_SHORT[d]}</button>`).join('') : '';
      sheet.querySelector('[data-rep-v]').textContent = rep.length ? cap(repeatLabel(rep)) : 'Ні';
      sheet.querySelector('[data-rephint]').textContent = !rep.length ? '' : task && task.rule
        ? `Повторюється ${repeatLabel(rep)}. Зміни застосуються до цього й наступних разів.`
        : `Повторюватиметься ${repeatLabel(rep)}, починаючи з ${sel === S.today ? 'сьогодні' : fmtDayMonth.format(parseKey(sel))}.`;
    };
    const paintDates = () => {
      const other = !chipDates.includes(sel);
      sheet.querySelector('[data-chips]').innerHTML = chipDates.map((d) =>
        `<button type="button" class="chip glass${d === sel ? ' on' : ''}" data-pick="${d}" aria-pressed="${d === sel}">${chipDay(d)}</button>`).join('')
        + `<button type="button" class="chip glass${other ? ' on' : ''}" data-cal-toggle>${ICAL}${other ? esc(fmtShortDM.format(parseKey(sel))) : 'Дата'}</button>`;
      // календар
      const first = new Date(t0.getFullYear(), t0.getMonth() + calOff, 1);
      const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const off = (first.getDay() + 6) % 7;
      let cells = '';
      for (let k = 0; k < off; k++) cells += '<span></span>';
      for (let n = 1; n <= days; n++) {
        const d = keyOf(new Date(first.getFullYear(), first.getMonth(), n));
        const st = dayState(d);
        cells += `<button type="button" class="mc${d === sel ? ' on' : ''}${d === S.today ? ' today' : ''}${st && d >= S.today ? ' has' : ''}${st && st.imp && d >= S.today ? ' imp' : ''}" data-pick="${d}" ${d < S.today ? 'disabled' : ''} aria-label="${esc(fmtLong.format(parseKey(d)))}">${n}</button>`;
      }
      sheet.querySelector('[data-cal]').innerHTML = `
        <div class="mc-head"><button type="button" class="icon-btn small" data-cal-d="-1" ${calOff <= 0 ? 'disabled' : ''} aria-label="Попередній місяць">${I.left}</button>
          <b>${esc(cap(fmtMonth.format(first).replace(' р.', '')))}</b>
          <button type="button" class="icon-btn small" data-cal-d="1" aria-label="Наступний місяць">${I.right}</button></div>
        <div class="mc-grid wds"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Нд</span></div>
        <div class="mc-grid">${cells}</div>`;
      sheet.querySelector('[data-save]').textContent = (task ? 'Зберегти ' : 'Додати ') + onDay(sel);
      paintRem(false);
    };
    const paintTime = () => {
      // час: початок і (необовʼязково) кінець
      sheet.querySelector('[data-timerow]').innerHTML = !time
        ? `<button type="button" class="tpill" data-add-time>${ICLOCK}<span>Додати час</span></button>`
        : `<div class="tpill on">${ICLOCK}<input type="time" value="${time}" data-time="start" aria-label="Початок"></div>
           <span class="tdash">–</span>
           ${endTime
            ? `<div class="tpill on"><input type="time" value="${endTime}" data-time="end" aria-label="Кінець"><button type="button" class="tclear" data-clear-end aria-label="Без кінця">${I.x}</button></div>`
            : `<button type="button" class="tpill" data-add-end><span>до…</span></button>`}
           <button type="button" class="tclear big" data-clear-time aria-label="Без часу">${I.x}</button>`;
    };
    const paintRem = (rebuildCustom) => {
      // нагадування
      const chips = [['off', 'Ні'], ...(time ? OFFSETS : []), ['custom', 'Свій час']];
      sheet.querySelector('[data-remchips]').innerHTML = chips.map(([v, l]) =>
        `<button type="button" class="chip glass${remMode === v ? ' on' : ''}" data-rem="${v}" aria-pressed="${remMode === v}">${l}</button>`).join('');
      if (rebuildCustom) {
        sheet.querySelector('[data-remcustom]').innerHTML = remMode === 'custom'
          ? `<div class="tpill on">${IBELL}<input type="time" value="${remAt}" data-time="rem" aria-label="Час нагадування"></div>` : '';
      }
      sheet.querySelector('[data-timehint]').textContent = time && endTime && endTime <= time ? 'Кінець має бути пізніше за початок' : '';
      const rt = remindTime();
      sheet.querySelector('[data-rem-v]').textContent = rt ? (remMode === 'custom' ? 'о ' + rt : (OFFSETS.find(([m]) => m === remMode) || [0, 'о ' + rt])[1]) : 'Ні';
      sheet.querySelector('[data-remhint]').textContent = rt
        ? `Нагадаю ${sel === S.today ? 'сьогодні' : sel === addDays(S.today, 1) ? 'завтра' : fmtDayMonth.format(parseKey(sel))} о ${rt}`
        : time ? 'Без нагадування' : 'Додай час, щоб нагадати «за N хвилин», або вибери свій час';
    };
    sheet.addEventListener('click', (e) => {
      const p = e.target.closest('[data-pick]');
      if (p && !p.disabled) {
        if (p.classList.contains('mc')) sheet.querySelector('[data-cal]').hidden = true;
        const was = repMode();
        sel = p.dataset.pick; calOff = Math.max(0, monthOff(sel));
        if (was === 'weekly' && !repCustom) rep = [parseKey(sel).getDay()];
        paint(); return;
      }
      const rp = e.target.closest('[data-rep]');
      if (rp) {
        const k = rp.dataset.rep;
        repCustom = k === 'custom';
        rep = k === 'none' ? [] : k === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : k === 'weekdays' ? [1, 2, 3, 4, 5] : k === 'weekly' ? [parseKey(sel).getDay()] : rep.length ? rep : [parseKey(sel).getDay()];
        paintRep(); return;
      }
      const wdb = e.target.closest('[data-wd]');
      if (wdb) {
        const d = Number(wdb.dataset.wd);
        rep = rep.includes(d) ? rep.filter((x) => x !== d) : rep.concat(d);
        if (!rep.length) repCustom = false;
        paintRep(); return;
      }
      if (e.target.closest('[data-cal-toggle]')) { const c = sheet.querySelector('[data-cal]'); c.hidden = !c.hidden; return; }
      const op = e.target.closest('[data-open]');
      if (op) {
        const b = sheet.querySelector(`[data-body="${op.dataset.open}"]`);
        b.hidden = !b.hidden; op.classList.toggle('open', !b.hidden);
        if (!b.hidden && op.dataset.open === 'note') { sheet.querySelector('[data-note-v]').textContent = ''; sheet.querySelector('#t-note').focus(); }
        return;
      }
      const cd = e.target.closest('[data-cal-d]');
      if (cd && !cd.disabled) { calOff = Math.max(0, calOff + Number(cd.dataset.calD)); paint(); return; }
      if (e.target.closest('[data-add-time]')) { time = '09:00'; paint(); return; }
      if (e.target.closest('[data-add-end]')) { endTime = minusMin(time, -60); if (endTime <= time) endTime = '23:59'; paint(); return; }
      if (e.target.closest('[data-clear-end]')) { endTime = ''; paint(); return; }
      if (e.target.closest('[data-clear-time]')) {
        if (remMode !== 'off' && remMode !== 'custom') { remAt = remindTime(); remMode = remAt ? 'custom' : 'off'; }
        time = ''; endTime = ''; paint(); return;
      }
      const r = e.target.closest('[data-rem]');
      if (r) {
        const v = r.dataset.rem;
        remMode = v === 'off' || v === 'custom' ? v : Number(v);
        if (remMode === 'custom' && !remAt) remAt = time ? minusMin(time, 15) : '09:00';
        paint();
      }
    });
    const onTime = (e) => {
      const k = e.target.dataset.time;
      if (!k || !e.target.value) return; // поле ще не дописане — чекаємо
      if (k === 'start') time = e.target.value;
      if (k === 'end') endTime = e.target.value;
      if (k === 'rem') remAt = e.target.value;
      paintRem(false); // оновлюємо лише підказки, саме поле лишається з курсором
    };
    sheet.addEventListener('input', onTime);
    sheet.addEventListener('change', onTime);
    paint();
    if (!task) setTimeout(() => title.focus(), 350);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') sheet.querySelector('[data-save]').click(); });

    sheet.querySelector('[data-save]').addEventListener('click', async () => {
      const txt = title.value.trim();
      if (!txt) { title.focus(); title.style.borderColor = '#FF8A80'; return; }
      if (time && endTime && endTime <= time) { toast('Кінець має бути пізніше за початок'); return; }
      const rt = remindTime();
      const fields = { title: txt, time, endTime: time && endTime > time ? endTime : '', remind: !!rt, remindAt: rt,
        note: sheet.querySelector('#t-note').value.trim().slice(0, 500), askNote: ask.getAttribute('aria-checked') === 'true',
        important: imp.getAttribute('aria-checked') === 'true' };
      const days = [...new Set(rep)].sort();
      let saved, msg;
      if (days.length && !task) {
        // нова серія
        await createRule({ ...fields, date: sel, repeat: days });
        saved = { ...fields, date: sel }; msg = 'Повторюватиметься ' + repeatLabel(days);
      } else if (task && task.rule && rule) {
        saved = await saveTask({ id: task.id, ...fields, date: sel });
        if (days.length) { await updateRule(rule, { ...fields, repeat: days }, task.date, task.id); msg = 'Збережено для цього й наступних'; }
        else { await patchTask(task.id, { rule: '' }); await endRule(rule, task.date, task.id); msg = 'Більше не повторюється'; }
      } else if (days.length && task) {
        // звичайне завдання стає серією: сама серія замінює його
        await patchTask(task.id, { deleted: true });
        await createRule({ ...fields, date: sel, repeat: days });
        saved = { ...fields, date: sel }; msg = 'Повторюватиметься ' + repeatLabel(days);
      } else {
        saved = await saveTask({ id: task?.id, ...fields, date: sel });
        msg = task ? 'Збережено' : `Додано ${onDay(saved.date)}`;
      }
      closeSheet();
      toast(msg);
      if (saved.remind) ensureTaskPush().catch((e) => toast(e.message || 'Сповіщення не ввімкнено'));
      rerenderAnimated();
    });
    const tm = sheet.querySelector('[data-tomorrow]');
    if (tm) tm.addEventListener('click', async () => {
      const d = addDays(S.today, 1);
      await patchTask(task.id, { date: d });
      closeSheet();
      toast('Перенесено на завтра');
      rerenderAnimated();
    });
    const del = sheet.querySelector('[data-del]');
    if (del) {
      let armed = false;
      del.addEventListener('click', async () => {
        if (task.rule && rule) {
          // серія: тільки цей раз або цей і всі наступні
          del.closest('.row-actions').outerHTML = `<div class="row-actions"><button class="btn block glass press" data-del-one>Тільки цей раз</button><button class="btn danger block press" data-del-all>Цей і наступні</button></div>`;
          sheet.querySelector('[data-del-one]').addEventListener('click', async () => {
            await patchTask(task.id, { deleted: true }); closeSheet(); toast('Видалено цей раз'); rerenderAnimated();
          });
          sheet.querySelector('[data-del-all]').addEventListener('click', async () => {
            await patchTask(task.id, { deleted: true }); await endRule(rule, task.date); closeSheet(); toast('Серію зупинено'); rerenderAnimated();
          });
          return;
        }
        if (!armed) { armed = true; del.textContent = 'Точно видалити?'; return; }
        await patchTask(task.id, { deleted: true });
        closeSheet();
        toast('Завдання видалено');
        rerenderAnimated();
      });
    }
  });
}
function minusMin(hhmm, m) {
  const [h, mi] = hhmm.split(':').map(Number);
  const t = (h * 60 + mi - m + 1440) % 1440;
  return pad(Math.floor(t / 60)) + ':' + pad(t % 60);
}

async function toggleTask(id, btn) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const wasAllDone = todayAllDone();
  // виконане перенесене завдання переїжджає в сьогодні — там його й видно як зроблене
  const patch = t.done ? { done: false } : { done: true, ...(t.date < S.today ? { date: S.today } : {}) };
  const row = btn.closest('.task');
  row?.classList.toggle('done', !t.done);
  popEl(btn);
  await patchTask(id, patch);
  const askNow = t.askNote && t.done;
  setTimeout(() => {
    rerender();
    if (askNow) setTimeout(() => openTaskNoteSheet(t, { afterMark: true }), 150);
    if (!wasAllDone && todayAllDone() && S.planMode !== 'cal') {
      confetti(currentView()?.querySelector('.pprog') || null);
      toast('Усі справи на сьогодні зроблено');
    }
  }, 280);
}
function openTaskNoteSheet(t, { afterMark = false } = {}) {
  const when = t.time ? ' · ' + timeRange(t) : '';
  openSheet(`
    <h2>${esc(t.title)}</h2>
    <div class="amount-sub">${esc(relDay(t.date))}${esc(when)} · <b class="${t.done ? 'ok' : ''}">${t.done ? 'Виконано' : 'Ще не виконано'}</b></div>
    ${t.note ? `<div class="habit-note-box">${INOTE}<span>${esc(t.note)}</span></div>` : ''}
    <label for="n-text" class="sr-only">Як пройшло</label>
    <textarea id="n-text" class="note-input big" rows="5" maxlength="500" placeholder="${afterMark ? 'Як пройшло? ' : ''}Результат, домовленості, що далі…">${esc(t.doneNote || '')}</textarea>
    ${journalSwitchHTML(journalOnFor(t.jAt), t.date)}
    <div class="row-actions">
      <button class="btn block glass press" data-skip>${afterMark ? 'Пропустити' : 'Скасувати'}</button>
      <button class="btn primary block press" data-ok>Зберегти</button>
    </div>
  `, (sheet) => {
    const ta = sheet.querySelector('#n-text');
    setTimeout(() => ta.focus(), 350);
    sheet.querySelector('[data-skip]').addEventListener('click', () => closeSheet());
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const jOn = journalSwitchOn(sheet);
      const txt = ta.value.trim();
      await patchTask(t.id, { doneNote: txt, jAt: txt ? journalStamp(jOn, t.jAt) : 0 });
      closeSheet();
      toast(noteToast(txt, jOn));
      rerender();
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sheet.querySelector('[data-ok]').click(); });
  });
}
/* ================= Режим сну ================= */
const IMOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
const ISUNRISE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v5M5.6 8.6l1.4 1.4M18.4 8.6L17 10M3 16h2M19 16h2M8 16a4 4 0 0 1 8 0M3 20h18"/></svg>';
const IBULB = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>';
const SLEEP_HABITS = {
  wake: { name: 'Підйом вчасно', full: 'встати за планом', min: 'встати до +1 год' },
  light: { name: 'Світло 20 хв', full: '20 хв денного світла', min: '5 хв світла' },
  coffee: { name: 'Кава до 15:00', full: 'остання кава до 15:00', min: 'остання кава до 16:00' },
  nap: { name: 'Денний сон ≤ 20 хв', full: 'без сну або ≤ 20 хв до 16:00', min: '≤ 30 хв' },
  dim: { name: 'Тьмяний режим', full: 'тепле світло за 2 год до відбою', min: 'за 1 год до відбою' },
  ideas: { name: 'Скинути ідеї', full: '5 хв записати всі ідеї', min: 'хоч одне речення' },
  bed: { name: 'Відбій вчасно', full: 'лягти за планом', min: 'лягти до +30 хв' },
  melatonin: { name: 'Мелатонін', full: 'за призначенням лікаря', min: 'за призначенням лікаря', note: 'Тільки після консультації з лікарем.' }
};
const SLEEP_ORDER = ['wake', 'light', 'coffee', 'nap', 'dim', 'ideas', 'bed'];
const sleepHabit = (key) => S.habits.find((h) => h.sleep === key);
const sleepActive = () => !!(S.sleepCfg && S.sleepCfg.active);
const sleepPlan = (date = S.today) => (sleepActive() ? planOn(S.sleepCfg, S.sleepDays, date) : null);
const nowHHMM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const bedAbsM = (t) => { const m = toMin(t); return m < 12 * 60 ? m + 1440 : m; };
const fmtDur = (m) => (m == null ? '—' : `${Math.floor(m / 60)} год${m % 60 ? ' ' + (m % 60) + ' хв' : ''}`);

async function putSleep(rec) {
  const r = { ...rec, updatedAt: Date.now(), dirty: true };
  await db.put('sleep', r);
  if (r.id === 's-cfg') S.sleepCfg = r.deleted ? null : r;
  else if (r.kind === 'day') { if (r.deleted) delete S.sleepDays[r.date]; else S.sleepDays[r.date] = r; }
  else { S.ideas = S.ideas.filter((x) => x.id !== r.id); if (!r.deleted) S.ideas.unshift(r); S.ideas.sort((a, b) => b.createdAt - a.createdAt); }
  scheduleSync();
  return r;
}
const saveSleepCfg = (patch) => putSleep({ id: 's-cfg', kind: 'cfg', ...(S.sleepCfg || {}), ...patch });
const setSleepDay = (date, patch) => putSleep({ id: 's-d-' + date, kind: 'day', date, bed: '', wake: '', shift: '', ...(S.sleepDays[date] || {}), ...patch });

async function ensureSleepHabits() {
  const want = SLEEP_ORDER.concat(S.sleepCfg && S.sleepCfg.melatonin ? ['melatonin'] : []);
  for (const key of want) {
    if (sleepHabit(key)) continue;
    const d = SLEEP_HABITS[key];
    await saveHabit({ name: d.name, full: d.full, min: d.min, kind: 'check', perWeek: 7, note: d.note || '', askNote: false, sleep: key });
  }
  // звички сну зʼявляються з дня старту програми
  for (const h of S.habits.filter((x) => x.sleep)) {
    if (S.sleepCfg && S.sleepCfg.start && h.start !== S.sleepCfg.start) {
      Object.assign(h, { start: S.sleepCfg.start, updatedAt: Date.now(), dirty: true });
      await db.put('habits', { ...h });
      scheduleSync();
    }
  }
  const mel = sleepHabit('melatonin');
  if (mel && !(S.sleepCfg && S.sleepCfg.melatonin)) await deleteHabit(mel.id);
}

// Підпис звички сну в списку: час береться з поточного етапу
function sleepSub(h, v, date) {
  const p = sleepPlan(date);
  if (!p) return h.sleep === 'melatonin' ? 'Тільки після консультації з лікарем' : '';
  const day = S.sleepDays[date] || {};
  const nextDay = S.sleepDays[addDays(date, 1)] || {};
  switch (h.sleep) {
    case 'wake': return day.wake ? `о ${p.wake} · встав о <em>${day.wake}</em>` : `о ${p.wake}${p.shift ? ' · рання зміна' : ''}`;
    case 'light': return `до ${fromMin(toMin(p.wake) + 30)}`;
    case 'coffee': return 'до 15:00';
    case 'nap': return 'до 20 хв, не після 16:00';
    case 'dim': return `з ${fromMin(toMin(p.bed) - 120)}`;
    case 'ideas': return `о ${p.creative}`;
    case 'bed': return nextDay.bed ? `о ${p.bed} · ліг о <em>${nextDay.bed}</em>` : `о ${p.bed}`;
    case 'melatonin': return 'Тільки після консультації з лікарем';
  }
  return '';
}

// Тап по звичці сну (ще не відміченій): свої віконця замість простої галочки
function sleepTap(h, date) {
  if (!sleepActive()) return false;
  if (h.sleep === 'wake' || h.sleep === 'bed') { openSleepTimeSheet(h, date); return true; }
  if (h.sleep === 'light' && date === S.today) { openLightTimer(h); return true; }
  if (h.sleep === 'ideas') { openIdeasSheet(h, date); return true; }
  return false;
}

async function markSleepHabit(h, date, v) {
  await setMark(h.id, date, v);
  const row = currentView()?.querySelector(`.habit[data-id="${h.id}"]`);
  if (row) { ripple(row); popEl(row.querySelector('.check')); updateTodayDynamic(row); } else rerender();
}

function openSleepTimeSheet(h, date) {
  const isWake = h.sleep === 'wake';
  // відбій після півночі — це ще «вчорашній» день
  let hDate = date;
  if (!isWake && date === S.today && new Date().getHours() < 6) hDate = addDays(date, -1);
  const p = sleepPlan(hDate);
  const logDate = isWake ? hDate : addDays(hDate, 1); // відбій пишемо в запис ранку, що за ним
  const plan = isWake ? p.wake : p.bed;
  const now = nowHHMM();
  const near = Math.abs(((toMin(now) - toMin(plan) + 1440 + 720) % 1440) - 720) <= 180;
  const start = (S.sleepDays[logDate] || {})[isWake ? 'wake' : 'bed'] || (date === S.today && near ? now : plan);
  openSheet(`
    <h2>${isWake ? 'О котрій встав?' : 'О котрій ліг?'}</h2>
    <div class="amount-sub">${esc(hDate === S.today ? 'Сьогодні' : fmtLong.format(parseKey(hDate)))} · план <b>${plan}</b>${isWake && p.shift ? ' (рання зміна)' : ''} · вчасно до ${fromMin(toMin(plan) + WAKE_GRACE)}</div>
    <div class="sleep-time"><input type="time" data-st value="${start}" aria-label="Час"></div>
    <div class="amount-status" data-verdict></div>
    <button class="btn primary block press" data-ok>Зберегти</button>
  `, (sheet) => {
    const inp = sheet.querySelector('[data-st]');
    const verdict = () => {
      if (!isTime(inp.value)) return null;
      const late = isWake ? toMin(inp.value) - toMin(plan) : bedAbsM(inp.value) - bedAbsM(plan);
      return late <= WAKE_GRACE ? 2 : 0;
    };
    const paint = () => {
      const v = verdict();
      sheet.querySelector('[data-verdict]').innerHTML = v === 2 ? '<b class="ok">Вчасно</b> · зараховано повністю'
        : v === 0 ? `Пізніше плану — не зараховано, але час запишу` : '';
    };
    inp.addEventListener('input', paint);
    paint();
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const v = verdict();
      if (v == null) { inp.focus(); return; }
      await setSleepDay(logDate, { [isWake ? 'wake' : 'bed']: inp.value });
      closeSheet();
      await markSleepHabit(h, hDate, v);
      if (hDate !== date) toast('Зараховано за вчора');
      else toast(v === 2 ? (isWake ? 'Встав вчасно' : 'Ліг вчасно') : 'Час записано, але не вчасно');
    });
  });
}

// Таймер світла: 20 хв. Початок памʼятаємо, тож можна вийти із застосунку.
const LIGHT_MS = 20 * 60e3;
const lightStart = () => { try { const v = JSON.parse(localStorage.getItem('lightTimer') || 'null'); return v && v.date === S.today ? v.at : 0; } catch (e) { return 0; } };
function openLightTimer(h) {
  let tick = null;
  const C = 2 * Math.PI * 70;
  openSheet(`
    <h2>Світло 20 хв</h2>
    <div class="amount-sub">Вийди надвір або сядь під яскраву лампу</div>
    <div class="ltimer"><svg viewBox="0 0 160 160"><circle class="track" cx="80" cy="80" r="70"/><circle class="bar" cx="80" cy="80" r="70" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-lbar/></svg>
      <div class="ltime"><b data-lt>20:00</b><small data-ls>готовий</small></div></div>
    <button class="btn primary block press" data-lgo>Старт</button>
    <button class="btn block glass press" data-ldone>Вже зробив</button>
  `, (sheet) => {
    const go = sheet.querySelector('[data-lgo]');
    const finish = async (v) => {
      clearInterval(tick);
      try { localStorage.removeItem('lightTimer'); } catch (e) { /* ок */ }
      closeSheet();
      await markSleepHabit(h, S.today, v);
      toast('Світло зараховано');
    };
    const paint = () => {
      const at = lightStart();
      const left = at ? Math.max(0, LIGHT_MS - (Date.now() - at)) : LIGHT_MS;
      const sec = Math.ceil(left / 1000);
      sheet.querySelector('[data-lt]').textContent = `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
      sheet.querySelector('[data-ls]').textContent = at ? (left ? 'іде' : 'готово!') : 'готовий';
      sheet.querySelector('[data-lbar]').style.strokeDashoffset = C * (left / LIGHT_MS);
      go.textContent = at ? 'Скинути' : 'Старт';
      if (at && !left) { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); finish(2); }
    };
    go.addEventListener('click', () => {
      try {
        if (lightStart()) localStorage.removeItem('lightTimer');
        else localStorage.setItem('lightTimer', JSON.stringify({ date: S.today, at: Date.now() }));
      } catch (e) { /* ок */ }
      paint();
    });
    sheet.querySelector('[data-ldone]').addEventListener('click', () => finish(2));
    tick = setInterval(() => { if (!sheet.isConnected) { clearInterval(tick); return; } paint(); }, 1000);
    paint();
  });
}

// «Скинути ідеї» → окремий список «Нічні ідеї»
function openIdeasSheet(h, date) {
  const today = S.ideas.filter((x) => x.date === date);
  openSheet(`
    <h2>Скинути ідеї</h2>
    <div class="amount-sub">5 хвилин — запиши все, що крутиться в голові. Далі тільки спокійні справи.</div>
    <label for="i-text" class="sr-only">Ідеї</label>
    <textarea id="i-text" class="note-input big" rows="6" maxlength="1000" placeholder="Ідеї, справи на завтра, думки…"></textarea>
    ${today.length ? `<div class="field"><label>${IBULB}Уже записано сьогодні</label><div class="notes-list">${today.map((x) => `<div class="note-item glass"><span>${esc(x.text)}</span></div>`).join('')}</div></div>` : ''}
    <button class="btn primary block press" data-ok>${h ? 'Зберегти і відмітити' : 'Зберегти'}</button>
  `, (sheet) => {
    const ta = sheet.querySelector('#i-text');
    setTimeout(() => ta.focus(), 350);
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const text = ta.value.trim();
      if (text) {
        const now = Date.now();
        await putSleep({ id: 's-i-' + now.toString(36) + Math.random().toString(36).slice(2, 6), kind: 'idea', date, text, createdAt: now });
      }
      closeSheet();
      if (h) await markSleepHabit(h, date, 2);
      else rerender();
      toast(text ? 'Ідеї збережено в «Нічні ідеї»' : 'Готово');
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sheet.querySelector('[data-ok]').click(); });
  });
}
function openIdeaEdit(idea) {
  openSheet(`
    <h2>Нічна ідея</h2>
    <div class="amount-sub">${esc(fmtLong.format(parseKey(idea.date)))}</div>
    <textarea id="i-text" class="note-input big" rows="6" maxlength="1000">${esc(idea.text)}</textarea>
    <button class="btn primary block press" data-ok>Зберегти</button>
    <button class="btn danger block press" data-del>Видалити</button>
  `, (sheet) => {
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const text = sheet.querySelector('#i-text').value.trim();
      await putSleep({ ...idea, text, deleted: !text });
      closeSheet(); rerender();
    });
    sheet.querySelector('[data-del]').addEventListener('click', async () => {
      await putSleep({ ...idea, deleted: true });
      closeSheet(); toast('Видалено'); rerender();
    });
  });
}

// Картка на екрані «Звички»
function sleepCardHTML() {
  if (!sleepActive() || S.selDate !== S.today) return '';
  const cfg = S.sleepCfg;
  const p = sleepPlan();
  if (!p) {
    const n = Math.max(0, -Math.round((parseKey(S.today) - parseKey(cfg.start)) / 864e5));
    return `<button class="sleepcard glass press" data-act="sleep-open"><span class="sc-ic">${IMOON}</span>
      <span class="sc-txt"><small>Режим сну</small><b>Старт ${n === 1 ? 'завтра' : 'через ' + n + ' ' + plural(n, 'день', 'дні', 'днів')}</b></span>${I.right}</button>`;
  }
  const hint = sleepHint(p);
  return `<button class="sleepcard glass press" data-act="sleep-open"><span class="sc-ic">${IMOON}</span>
    <span class="sc-txt"><small>Режим сну · етап ${p.idx + 1} з ${STAGES}</small>
      <b>Підйом ${p.wake} · Відбій ${p.bed}</b>${hint ? `<em>${esc(hint)}</em>` : ''}</span>${I.right}</button>`;
}
function sleepHint(p) {
  const y = S.sleepDays[addDays(S.today, -1)];
  if (y && y.shift) return `Після ранньої зміни не відсипайся довше ніж до ${fromMin(toMin(p.planWake) + 60)}`;
  if (p.shift) return `Сьогодні рання зміна — підйом о ${p.shift}`;
  return '';
}

function sleepStreak() {
  const h = sleepHabit('wake');
  if (!h) return 0;
  let d = val(h.id, S.today) === 2 ? S.today : addDays(S.today, -1), n = 0;
  while (val(h.id, d) === 2 && d >= S.sleepCfg.start) { n++; d = addDays(d, -1); }
  return n;
}
function onTimeIn(from, to) {
  const h = sleepHabit('wake');
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (h && val(h.id, d) === 2) n++;
  return n;
}
async function repeatSleepWeek() {
  const st = stageOn(S.sleepCfg, S.today);
  if (!st || st.idx === 0) { toast('Це вже перший етап'); return; }
  await saveSleepCfg({ repeats: (S.sleepCfg.repeats || 0) + 1 });
  try { localStorage.setItem('sleepRepeatAsked', String(st.week)); } catch (e) { /* ок */ }
  toast('Цей тиждень — знову попередній етап');
  rerenderAnimated();
}

function sleepChartHTML() {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(addDays(S.today, -i));
  const pts = days.map((d) => {
    const p = sleepPlan(d);
    const w = (S.sleepDays[d] || {}).wake;
    return { d, plan: p ? toMin(p.wake) : null, act: isTime(w) ? toMin(w) : null };
  });
  const vals = pts.flatMap((x) => [x.plan, x.act]).filter((x) => x != null);
  if (!pts.some((x) => x.act != null)) return `<div class="sc-empty">Тут зʼявиться графік, щойно почнеш відмічати «Підйом вчасно».</div>`;
  let lo = Math.min(...vals) - 30, hi = Math.max(...vals) + 30;
  lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60;
  const W = 320, H = 150, L = 38, R = 8, T = 10, B = 22;
  const x = (i) => L + (W - L - R) * i / 29;
  const y = (m) => T + (H - T - B) * (m - lo) / (hi - lo); // раніше — вище
  let planPath = '', prev = null;
  pts.forEach((p, i) => {
    if (p.plan == null) { prev = null; return; }
    planPath += prev == null ? `M${x(i).toFixed(1)},${y(p.plan).toFixed(1)}` : `H${x(i).toFixed(1)}V${y(p.plan).toFixed(1)}`;
    prev = p.plan;
  });
  const act = pts.map((p, i) => (p.act == null ? null : [x(i), y(p.act), p])).filter(Boolean);
  const line = act.map((a, i) => (i ? 'L' : 'M') + a[0].toFixed(1) + ',' + a[1].toFixed(1)).join('');
  const grid = [];
  for (let m = lo; m <= hi; m += 60) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(m)}" y2="${y(m)}"/><text x="${L - 6}" y="${y(m) + 3.5}" text-anchor="end">${fromMin(m)}</text>`);
  const lbl = [0, 15, 29].map((i) => `<text x="${x(i)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === 29 ? 'end' : 'middle'}">${esc(fmtShortDM.format(parseKey(days[i])))}</text>`).join('');
  return `<svg class="schart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Час підйому за 30 днів проти плану">
    <g class="grid">${grid.join('')}</g>
    <path class="plan" d="${planPath}"/>
    <path class="act" d="${line}"/>
    ${act.map(([cx, cy, p]) => `<circle class="${p.plan != null && p.act - p.plan <= WAKE_GRACE ? 'ok' : 'late'}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.4"/>`).join('')}
    <g class="xl">${lbl}</g></svg>
    <div class="slegend"><span><i class="l-act"></i>Фактичний підйом</span><span><i class="l-plan"></i>План</span></div>`;
}

function renderSleep(el) {
  const cfg = S.sleepCfg;
  const back = `<button class="icon-btn glass press" data-act="sleep-back" aria-label="Назад">${I.left}</button>`;
  if (!sleepActive()) {
    el.innerHTML = `
      ${headHTML({ eyebrow: 'Звички', title: 'Режим сну', back, dot: false })}
      <div class="empty glass"><span class="jbig sl">${IMOON}</span><h2>Перезапуск сну за 4 тижні</h2>
        <p>Щотижня підйом і відбій зсуваються трохи раніше. Застосунок сам додасть звички, нагадуватиме про світло, каву й відбій і покаже прогрес.</p>
        <button class="btn primary press" data-act="sleep-setup">Налаштувати</button></div>`;
    return;
  }
  const st = stageOn(cfg, S.today);
  const stages = stagesOf(cfg);
  const p = sleepPlan();
  const wk = st ? st.week + 1 : 0;
  const title = !st ? 'Скоро старт' : st.idx === STAGES - 1 && wk > STAGES ? 'Ціль тримається' : `Етап ${st.idx + 1} з ${STAGES}`;
  // пропозиція повторити етап — один рядок
  let note = '';
  if (st && st.week >= 1 && st.idx > 0) {
    const ws = addDays(cfg.start, (st.week - 1) * 7);
    const n = onTimeIn(ws, addDays(ws, 6));
    let asked = '';
    try { asked = localStorage.getItem('sleepRepeatAsked') || ''; } catch (e) { /* ок */ }
    if (n < 5 && asked !== String(st.week)) {
      note = `<div class="sl-note glass"><span>Вчасно минулого тижня: <b>${n} з 7</b></span>
        <button class="sl-note-btn press" data-act="sleep-repeat">Повторити</button>
        <button class="sl-note-x" data-act="sleep-norepeat" data-w="${st.week}" aria-label="Ні, далі">${I.x}</button></div>`;
    }
  }
  const hint = p ? sleepHint(p) : '';
  const line = stages.map((sg, i) => `${i ? `<u class="${st && st.idx >= i ? 'y' : ''}"></u>` : ''}<i class="${st && st.idx > i ? 'y' : st && st.idx === i ? 'c' : ''}"></i>`).join('');
  let sum = 0, cnt = 0;
  for (let i = 0; i < 7; i++) { const r = S.sleepDays[addDays(S.today, -i)] || {}; const d = sleepMinutes(r.bed, r.wake); if (d != null) { sum += d; cnt++; } }
  const shifts = Object.values(S.sleepDays).filter((r) => r.shift && r.date >= S.today).length;
  const streak = sleepStreak();
  el.innerHTML = `
    ${headHTML({ eyebrow: 'Режим сну' + (st ? ' · тиждень ' + wk : ''), title, back,
      actions: `<button class="icon-btn glass press" data-act="sleep-setup" aria-label="Налаштування режиму сну">${I.gear}</button>` })}
    <div class="cols">
    <div class="col sticky">
    <div class="sl-today glass">
      ${p ? `<div class="sl-big"><span><small>Підйом${p.shift ? ' · зміна' : ''}</small><b>${p.wake}</b></span><span><small>Відбій</small><b>${p.bed}</b></span></div>
      <div class="sl-small"><span>Світло до <b>${fromMin(toMin(p.wake) + 30)}</b></span><span>Кава до <b>15:00</b></span><span>Тьмяне з <b>${fromMin(toMin(p.bed) - 120)}</b></span></div>`
      : `<div class="sl-hint">Програма почнеться ${esc(fmtLong.format(parseKey(cfg.start)))}.</div>`}
      <div class="sl-line">${line}</div>
      <div class="sl-line-l">${stages.map((sg) => `<span>${sg.wake}</span>`).join('')}</div>
      ${hint ? `<div class="sl-hint">${esc(hint)}</div>` : ''}
    </div>
    ${note}
    </div>
    <div class="col">
    <div class="sl-sec glass"><div class="sl-h"><b>Підйом за 30 днів</b><span>${streak ? streak + ' ' + plural(streak, 'день', 'дні', 'днів') + ' поспіль вчасно' : 'план пунктиром'}</span></div>${sleepChartHTML()}</div>
    <div class="set-group">
      <button class="set-row link" data-act="sleep-log"><div class="l"><b>Журнал сну</b><span>${cnt ? 'середній сон ' + fmtDur(Math.round(sum / cnt)) : 'записуй, коли ліг і встав'}</span></div>${I.right}</button>
      <button class="set-row link" data-act="sleep-shifts"><div class="l"><b>Ранні зміни</b><span>${shifts ? shifts + ' ' + plural(shifts, 'запланована', 'заплановані', 'запланованих') : 'немає запланованих'}</span></div>${I.right}</button>
      <button class="set-row link" data-act="sleep-ideas"><div class="l"><b>Нічні ідеї</b><span>${S.ideas.length ? S.ideas.length + ' ' + plural(S.ideas.length, 'запис', 'записи', 'записів') : 'поки порожньо'}</span></div>${I.right}</button>
    </div>
    </div>
    </div>`;
}
function openSleepLogSheet() {
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(S.today, -i);
    const r = S.sleepDays[d] || {};
    const dur = sleepMinutes(r.bed, r.wake);
    rows.push(`<button class="sl-row" data-day="${d}"><span class="d">${esc(i === 0 ? 'Сьогодні' : i === 1 ? 'Вчора' : cap(fmtWdShortDate.format(parseKey(d))))}${r.shift ? ' <i class="shift">зміна</i>' : ''}</span>
      <span class="t">${r.bed || '—'} → ${r.wake || '—'}</span><span class="dur">${dur != null ? fmtDur(dur) : ''}</span></button>`);
  }
  openSheet(`<h2>Журнал сну</h2><div class="amount-sub">Тап по ночі — змінити час</div><div class="sl-list">${rows.join('')}</div>`, (sheet) => {
    sheet.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => openSleepDaySheet(b.dataset.day)));
  });
}
function openShiftsSheet() {
  const list = Object.values(S.sleepDays).filter((r) => r.shift && r.date >= S.today).sort((a, b) => (a.date < b.date ? -1 : 1));
  openSheet(`<h2>Ранні зміни</h2>
    <div class="amount-sub">У день зміни підйом і світло нагадаю за часом зміни, а відбій — за планом.</div>
    ${list.length ? `<div class="sl-list">${list.map((r) => `<button class="sl-row" data-day="${r.date}"><span class="d">${esc(cap(fmtWdShortDate.format(parseKey(r.date))))}</span><span class="t">підйом ${r.shift}</span><span class="dur"></span></button>`).join('')}</div>` : ''}
    <button class="btn primary block press" data-add>Додати зміну</button>`, (sheet) => {
    sheet.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => openSleepDaySheet(b.dataset.day)));
    sheet.querySelector('[data-add]').addEventListener('click', () => openShiftSheet());
  });
}
function openIdeasListSheet() {
  openSheet(`<h2>Нічні ідеї</h2>
    ${S.ideas.length ? `<div class="sl-list">${S.ideas.slice(0, 50).map((x) => `<button class="sl-idea" data-id="${x.id}"><small>${esc(fmtShortDM.format(parseKey(x.date)))}</small><span>${esc(x.text)}</span></button>`).join('')}</div>`
      : '<div class="amount-sub">Тут збиратиметься все, що запишеш у «Скинути ідеї».</div>'}
    <button class="btn primary block press" data-add>Записати ідею</button>`, (sheet) => {
    sheet.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => { const idea = S.ideas.find((x) => x.id === b.dataset.id); if (idea) openIdeaEdit(idea); }));
    sheet.querySelector('[data-add]').addEventListener('click', () => openIdeasSheet(null, S.today));
  });
}

function openSleepDaySheet(date) {
  const r = S.sleepDays[date] || {};
  openSheet(`
    <h2>Ніч на ${esc(fmtDayMonth.format(parseKey(date)))}</h2>
    <div class="amount-sub">Відбій напередодні ввечері → підйом цього ранку</div>
    <div class="field-row">
      <div class="field"><label>Ліг</label><input type="time" data-bed value="${r.bed || ''}"></div>
      <div class="field"><label>Встав</label><input type="time" data-wake value="${r.wake || ''}"></div>
    </div>
    <div class="field"><label>Рання зміна · свій час підйому <span class="opt">необовʼязково</span></label><input type="time" data-shift value="${r.shift || ''}"></div>
    <div class="amount-status" data-dur></div>
    <button class="btn primary block press" data-ok>Зберегти</button>
  `, (sheet) => {
    const q = (s) => sheet.querySelector(s);
    const paint = () => { const d = sleepMinutes(q('[data-bed]').value, q('[data-wake]').value); q('[data-dur]').innerHTML = d != null ? `Сон: <b class="ok">${fmtDur(d)}</b>` : ''; };
    sheet.querySelectorAll('input').forEach((i) => i.addEventListener('input', paint));
    paint();
    q('[data-ok]').addEventListener('click', async () => {
      await setSleepDay(date, { bed: q('[data-bed]').value, wake: q('[data-wake]').value, shift: q('[data-shift]').value });
      closeSheet(); toast('Збережено'); rerender();
    });
  });
}
function openShiftSheet() {
  openSheet(`
    <h2>Рання зміна</h2>
    <div class="amount-sub">Підйом і світло цього дня — за часом зміни, відбій — за планом. Наступного ранку не відсипайся більше ніж +1 год.</div>
    <div class="field-row">
      <div class="field"><label>День</label><input type="date" data-d value="${addDays(S.today, 1)}" min="${S.today}"></div>
      <div class="field"><label>Підйом</label><input type="time" data-t value="06:00"></div>
    </div>
    <button class="btn primary block press" data-ok>Додати</button>
  `, (sheet) => {
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const d = sheet.querySelector('[data-d]').value, t = sheet.querySelector('[data-t]').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isTime(t)) { toast('Вкажи день і час'); return; }
      await setSleepDay(d, { shift: t });
      closeSheet(); toast('Зміну додано'); rerender();
    });
  });
}

function openSleepSetup() {
  const c = { ...SLEEP_DEFAULTS, notif: {}, ...(S.sleepCfg || {}) };
  const active = sleepActive();
  const notif = Object.fromEntries(NOTIFS.map(([k]) => [k, !(c.notif && c.notif[k] === false)]));
  const tIn = (k, label) => `<div class="field"><label>${label}</label><input type="time" data-c="${k}" value="${esc(c[k])}"></div>`;
  openSheet(`
    <h2>Режим сну</h2>
    <div class="amount-sub">4 тижні: щотижня підйом і відбій трохи раніше. Якщо твої часи інші — зсунь, етапи перерахуються рівномірно.</div>
    <div class="field-row">${tIn('curBed', 'Зараз засинаю')}${tIn('curWake', 'Зараз встаю')}</div>
    <div class="field-row">${tIn('tgtBed', 'Ціль: відбій')}${tIn('tgtWake', 'Ціль: підйом')}</div>
    <div class="field"><label>Старт</label><input type="date" data-start value="${esc(c.start || S.today)}"></div>
    <div class="sl-stages" data-prev></div>
    <div class="field"><label>${IBELL}Сповіщення</label></div>
    <div class="set-group">${NOTIFS.map(([k, l]) => `<div class="set-row"><div class="l"><b>${esc(l)}</b></div><button type="button" class="switch" role="switch" aria-checked="${notif[k]}" data-n="${k}" aria-label="${esc(l)}"></button></div>`).join('')}</div>
    <div class="set-group"><div class="set-row"><div class="l"><b>Мелатонін</b><span>Звичка вимкнена за замовчуванням. Тільки після консультації з лікарем.</span></div>
      <button type="button" class="switch" role="switch" aria-checked="${!!c.melatonin}" data-mel aria-label="Мелатонін"></button></div></div>
    <button class="btn primary block press" data-ok>${active ? 'Зберегти' : 'Почати програму'}</button>
    ${active ? '<button class="btn danger block press" data-off>Завершити програму</button>' : ''}
  `, (sheet) => {
    const val2 = (k) => sheet.querySelector(`[data-c="${k}"]`).value;
    const paint = () => {
      const cfg = {}; Object.keys(SLEEP_DEFAULTS).forEach((k) => { cfg[k] = val2(k); });
      sheet.querySelector('[data-prev]').innerHTML = stagesOf(cfg).map((s, i) => `<div class="sl-stage"><small>Етап ${i + 1}${i === STAGES - 1 ? '+' : ''}</small><b>${s.wake}</b><span>${s.bed}</span></div>`).join('');
    };
    sheet.querySelectorAll('[data-c]').forEach((i) => i.addEventListener('input', paint));
    sheet.querySelectorAll('.switch').forEach((sw) => sw.addEventListener('click', () => sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'))));
    paint();
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const patch = { active: true, start: sheet.querySelector('[data-start]').value || S.today, repeats: S.sleepCfg ? S.sleepCfg.repeats || 0 : 0,
        notif: Object.fromEntries([...sheet.querySelectorAll('[data-n]')].map((sw) => [sw.dataset.n, sw.getAttribute('aria-checked') === 'true'])),
        melatonin: sheet.querySelector('[data-mel]').getAttribute('aria-checked') === 'true' };
      for (const k of Object.keys(SLEEP_DEFAULTS)) { const v = val2(k); if (!isTime(v)) { toast('Заповни всі часи'); return; } patch[k] = v; }
      if (S.sleepCfg && S.sleepCfg.start !== patch.start) patch.repeats = 0;
      const first = !active;
      await saveSleepCfg(patch);
      await ensureSleepHabits();
      if (first && !S.tasks.some((t) => t.title.startsWith('Записатися до Hausarzt'))) {
        await saveTask({ title: 'Записатися до Hausarzt → направлення до Schlafmediziner', date: S.today, note: 'Мелатонін — тільки після консультації.' });
      }
      closeSheet();
      toast(first ? 'Програму запущено' : 'Збережено');
      if (Object.values(patch.notif).some(Boolean)) ensureTaskPush().catch((e) => toast(e.message || 'Сповіщення не ввімкнено'));
      if (S.tab === 'sleep') rerenderAnimated(); else showTab('sleep');
    });
    sheet.querySelector('[data-off]')?.addEventListener('click', async () => {
      if (!confirm('Завершити програму? Звички сну зникнуть зі списку, журнал і ідеї залишаться.')) return;
      await saveSleepCfg({ active: false });
      for (const k of Object.keys(SLEEP_HABITS)) { const h = sleepHabit(k); if (h) await deleteHabit(h.id); }
      closeSheet(); toast('Програму завершено'); rerenderAnimated();
    });
  });
}

/* ================= Щоденник ================= */
// Перемикач «Додати в щоденник»: запамʼятовуємо останній вибір
const journalPref = () => { try { return localStorage.getItem('journalDefault') !== '0'; } catch (e) { return true; } };
const journalOnFor = (jAt) => (jAt > 0 ? true : journalPref());
const journalStamp = (on, prev) => (on ? prev || Date.now() : 0);
const journalSwitchOn = (sheet) => {
  const sw = sheet.querySelector('[data-journal]');
  if (!sw) return false;
  const on = sw.getAttribute('aria-checked') === 'true';
  try { localStorage.setItem('journalDefault', on ? '1' : '0'); } catch (e) { /* ок */ }
  return on;
};
const noteToast = (txt, jOn) => (!txt ? 'Нотатку прибрано' : jOn ? 'Збережено · є в щоденнику' : 'Нотатку збережено');
function journalSwitchHTML(on, date) {
  const when = date === S.today ? 'за сьогодні' : 'за ' + fmtDayMonth.format(parseKey(date));
  return `<div class="set-group"><div class="set-row jswitch"><span class="jic">${I.book}</span>
    <div class="l"><b>Додати в щоденник</b><span>Зʼявиться в записах ${esc(when)}</span></div>
    <button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="Додати в щоденник" data-journal></button></div></div>`;
}

async function saveJournal(data) {
  const now = Date.now();
  let j = data.id ? S.journal.find((x) => x.id === data.id) : null;
  if (j) Object.assign(j, { date: data.date, text: data.text, updatedAt: now, dirty: true });
  else {
    j = { id: 'j-' + now.toString(36) + Math.random().toString(36).slice(2, 7), date: data.date, text: data.text,
      createdAt: now, updatedAt: now, deleted: false, dirty: true };
    S.journal.push(j);
  }
  await db.put('journal', { ...j });
  scheduleSync();
  return j;
}
async function deleteJournal(id) {
  const j = S.journal.find((x) => x.id === id);
  if (!j) return;
  S.journal = S.journal.filter((x) => x.id !== id);
  await db.put('journal', { ...j, deleted: true, updatedAt: Date.now(), dirty: true });
  scheduleSync();
}

// Усі записи: власні + нотатки звичок і завдань, позначені «в щоденник»
function journalEntries() {
  const out = S.journal.map((j) => ({ kind: 'me', ref: j.id, date: j.date, at: j.createdAt, text: j.text }));
  for (const [k, m] of S.marks) {
    if (!m.jAt || !m.note) continue;
    const [hid, date] = k.split('|');
    const h = habitById(hid);
    if (!h) continue;
    let label = h.name;
    if (isCount(h) && m.amount != null) label += ` · ${fmtNum(m.amount)} / ${fmtNum(h.target)}${h.unit ? ' ' + h.unit : ''}`;
    else if (m.value === 1) label += ' · мінімум';
    out.push({ kind: 'habit', ref: k, date, at: m.jAt, text: m.note, label, done: m.value > 0 });
  }
  for (const t of S.tasks) {
    if (!t.jAt || !t.doneNote) continue;
    out.push({ kind: 'task', ref: t.id, date: t.date, at: t.jAt, text: t.doneNote, label: t.title + (t.time ? ' · ' + timeRange(t) : ''), done: t.done });
  }
  return out;
}
const J_FILTERS = [['all', 'Усе'], ['me', 'Мої'], ['habit', 'Звички'], ['task', 'План']];
const jDayTitle = (d) => (d === S.today ? 'Сьогодні' : d === addDays(S.today, -1) ? 'Вчора' : cap(fmtDayMonth.format(parseKey(d))));
const jDaySub = (d) => (d === S.today || d === addDays(S.today, -1) ? fmtWdShortDate.format(parseKey(d)) : fmtWeekday.format(parseKey(d)));

function journalCard(e, i) {
  const time = e.at ? fmtTime.format(new Date(e.at)) : '';
  const pill = e.kind === 'me' ? '<span></span>'
    : `<span class="jsrc jp-${e.kind}">${e.done ? I.check : ''}<span>${esc(e.label)}</span></span>`;
  return `<button class="jcard glass" data-act="j-open" data-kind="${e.kind}" data-ref="${esc(e.ref)}" style="--i:${i}">
    <span class="jtop">${pill}<span class="jtime">${esc(time)}</span></span>
    <span class="jtext">${esc(e.text)}</span>
  </button>`;
}
function journalListHTML() {
  const all = journalEntries();
  const q = S.jQuery.trim().toLowerCase();
  const list = all.filter((e) => (S.jFilter === 'all' || e.kind === S.jFilter)
    && (!q || e.text.toLowerCase().includes(q) || (e.label || '').toLowerCase().includes(q)))
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.at - a.at));
  if (!all.length) {
    return `<div class="empty glass jempty"><span class="jbig">${I.book}</span><h2>Тут буде твій щоденник</h2>
      <p>Пиши про свій день через «+». А нотатки «Як пройшло?» до звичок і справ потрапляють сюди, якщо увімкнути «Додати в щоденник».</p>
      <button class="btn primary press" data-act="j-add">${I.plus.replace('<svg', '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')}Написати запис</button></div>`;
  }
  if (!list.length) return `<div class="jnone">${q ? 'Нічого не знайдено' : 'Тут поки порожньо'}</div>`;
  let html = '', day = null, i = 0;
  for (const e of list) {
    if (e.date !== day) {
      if (day) html += '</div>';
      day = e.date;
      html += `<div class="jday"><div class="jdayh"><b>${esc(jDayTitle(day))}</b><span>${esc(jDaySub(day))}</span></div>`;
    }
    html += journalCard(e, Math.min(i++, 12));
  }
  return html + '</div>';
}
function renderJournal(el) {
  const total = journalEntries().length;
  const month = cap(new Intl.DateTimeFormat('uk', { month: 'long' }).format(parseKey(S.today)));
  el.innerHTML = `
    ${headHTML({ eyebrow: month + (total ? ' · ' + total + ' ' + plural(total, 'запис', 'записи', 'записів') : ''), title: 'Щоденник',
      actions: `<button class="icon-btn glass press${S.jSearch ? ' on' : ''}" data-act="j-search" aria-label="Пошук" aria-pressed="${S.jSearch}">${I.search}</button><button class="icon-btn lime press" data-act="j-add" aria-label="Новий запис">${I.plus}</button>` })}
    ${S.jSearch ? `<label class="jsearch glass">${I.search}<input data-jq type="search" placeholder="Пошук у записах" value="${esc(S.jQuery)}" autocomplete="off" enterkeyhint="search"></label>` : ''}
    ${segHTML(J_FILTERS, S.jFilter, 'j-filter', 'Фільтр')}
    <div class="jlist" data-jlist>${journalListHTML()}</div>`;
  const qi = el.querySelector('[data-jq]');
  if (qi) qi.addEventListener('input', () => { S.jQuery = qi.value; el.querySelector('[data-jlist]').innerHTML = journalListHTML(); });
}

function openJournalSheet(j = null) {
  let date = j ? j.date : S.today;
  openSheet(`
    <div class="jsheet-head"><h2>${j ? 'Запис' : 'Новий запис'}</h2>
      <label class="jdate glass">${ICAL}<span data-jdate-l></span><input type="date" data-jdate value="${date}" max="${S.today}" aria-label="Дата запису"></label></div>
    <label for="j-text" class="sr-only">Текст запису</label>
    <textarea id="j-text" class="note-input big jta" rows="8" maxlength="3000" placeholder="Як пройшов день? Що вдалось, що думаєш, за що вдячний…">${esc(j ? j.text : '')}</textarea>
    <button class="btn primary block press" data-ok>Зберегти запис</button>
    ${j ? '<button class="btn danger block press" data-del>Видалити запис</button>' : ''}
  `, (sheet) => {
    const ta = sheet.querySelector('#j-text');
    const di = sheet.querySelector('[data-jdate]');
    const paintDate = () => { sheet.querySelector('[data-jdate-l]').textContent = date === S.today ? 'Сьогодні' : date === addDays(S.today, -1) ? 'Вчора' : fmtShortDM.format(parseKey(date)); };
    di.addEventListener('change', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(di.value)) { date = di.value; paintDate(); } });
    paintDate();
    if (!j) setTimeout(() => ta.focus(), 350);
    sheet.querySelector('[data-ok]').addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); toast('Напиши хоч кілька слів'); return; }
      await saveJournal({ id: j?.id, date, text });
      closeSheet();
      toast(j ? 'Запис оновлено' : 'Запис додано');
      if (S.tab === 'journal') rerenderAnimated();
    });
    sheet.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm('Видалити цей запис?')) return;
      await deleteJournal(j.id);
      closeSheet();
      toast('Запис видалено');
      rerender();
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sheet.querySelector('[data-ok]').click(); });
  });
}

function todayAllDone() {
  const l = tasksOn(S.today);
  return l.length > 0 && l.every((t) => t.done) && carriedTasks().length === 0;
}

// Конфеті, коли день зараховано або тижнева ціль звички щойно виконана
function celebrate(h, date, before, row) {
  if (!before.day && dayCounted(date)) {
    confetti(currentView().querySelector('.ring'));
    toast(date === S.today ? 'День зараховано — ланцюжок росте' : 'День зараховано');
  } else if (!isDaily(h) && !before.week && weekMet(h, weekStart(date))) {
    confetti(row?.querySelector('.check') || currentView().querySelector('.ring'));
    toast(`Тижнева ціль: ${h.name} ✓`);
  }
}

/* ================= Події ================= */
let pressTimer = null, suppressClick = false, pressRow = null, pressXY = null;
views.addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.habit');
  if (!row) return;
  pressRow = row; pressXY = [e.clientX, e.clientY];
  pressTimer = setTimeout(() => {
    row.classList.add('holding');
    suppressClick = true;
    setTimeout(() => row.classList.remove('holding'), 200);
    openHabitSheet(S.habits.find((h) => h.id === row.dataset.id));
  }, 550);
});
const cancelPress = () => { clearTimeout(pressTimer); pressRow = null; };
views.addEventListener('pointerup', cancelPress);
views.addEventListener('pointercancel', cancelPress);
views.addEventListener('pointermove', (e) => {
  if (pressRow && pressXY && Math.hypot(e.clientX - pressXY[0], e.clientY - pressXY[1]) > 10) cancelPress();
});
views.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.habit');
  if (!row) return;
  e.preventDefault();
  if (e.pointerType !== 'touch' && e.button === 2) openHabitSheet(S.habits.find((h) => h.id === row.dataset.id));
});

views.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'habit') {
    if (suppressClick) { suppressClick = false; return; }
    const id = t.dataset.id;
    const date = S.selDate;
    const hb = habitById(id);
    const before = { day: dayCounted(date), week: !isDaily(hb) && weekMet(hb, weekStart(date)) };
    if (isCount(hb)) {
      openAmountSheet(hb, date, () => {
        const row = currentView()?.querySelector(`.habit[data-id="${id}"]`);
        if (row) { ripple(row); popEl(row.querySelector('.check')); }
        updateTodayDynamic(row);
        celebrate(hb, date, before, row);
      });
      return;
    }
    const prevVal = val(id, date);
    if (hb.sleep && prevVal === 0 && sleepTap(hb, date)) return;
    const v = nextVal(prevVal);
    ripple(t, e);
    popEl(t.querySelector('.check'));
    await setMark(id, date, v);
    updateTodayDynamic(t);
    celebrate(hb, date, before, t);
    if (hb.askNote && prevVal === 0 && v > 0) setTimeout(() => openNoteSheet(hb, date, { afterMark: true }), 380);
  } else if (act === 'habit-note') {
    const hb = habitById(t.dataset.id);
    if (hb) openNoteSheet(hb, S.selDate);
  } else if (act === 'day') {
    S.selDate = t.dataset.date;
    rerenderAnimated();
  } else if (act === 'add') {
    openHabitSheet();
  } else if (act === 'template') {
    const tp = TEMPLATES[+t.dataset.i];
    await saveHabit({ ...tp });
    toast('Додано: ' + tp.name);
    rerenderAnimated();
  } else if (act === 'settings') {
    openSettings();
  } else if (act === 'cell') {
    const { id, date } = t.dataset;
    const hc = habitById(id);
    if (isCount(hc)) {
      openAmountSheet(hc, date, () => rerender());
      return;
    }
    await setMark(id, date, nextVal(val(id, date)));
    t.classList.remove('v0', 'v1', 'v2');
    t.classList.add('v' + val(id, date));
    popEl(t);
    const mi = monthInfo();
    const bar = currentView().querySelector(`[data-bar="${date}"] i`);
    if (bar) bar.style.height = Math.max(3, Math.round((dayScore(date) || 0) * 28)) + 'px';
    currentView().querySelector('[data-kpis]').innerHTML = tableKpis(mi);
    const h = S.habits.find((x) => x.id === id);
    const rs = currentView().querySelector(`[data-rs="${id}"]`);
    if (rs) rs.textContent = rowScore(h, mi);
  } else if (act === 'prog') {
    if (S.progMode === t.dataset.v) return;
    S.progMode = t.dataset.v;
    rerenderAnimated();
  } else if (act === 'month') {
    S.monthOffset = Math.min(0, S.monthOffset + Number(t.dataset.d));
    rerenderAnimated();
  } else if (act === 'period') {
    if (S.period === t.dataset.p) return;
    S.period = t.dataset.p;
    const seg = t.closest('.seg');
    seg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b === t); b.setAttribute('aria-selected', b === t); });
    placeKnob(currentView());
    setTimeout(() => rerenderAnimated(), 120);
  } else if (act === 'plan-mode') {
    if (S.planMode === t.dataset.v) return;
    S.planMode = t.dataset.v;
    if (S.planMode === 'cal') { const p = parseKey(S.planDate), n = parseKey(S.today); S.calOffset = (p.getFullYear() - n.getFullYear()) * 12 + p.getMonth() - n.getMonth(); }
    rerenderAnimated();
  } else if (act === 'plan-day') {
    S.planDate = t.dataset.date;
    S.calOffset = monthsFromToday(S.planDate);
    rerenderAnimated();
  } else if (act === 'plan-open') {
    S.planDate = t.dataset.date;
    S.calOffset = monthsFromToday(S.planDate);
    if (S.planMode === 'cal') { rerender(); return; } // у календарі — показуємо справи дня під ним
    S.planMode = 'day';
    rerenderAnimated();
  } else if (act === 'cal-nav') {
    S.calOffset += Number(t.dataset.d);
    rerenderAnimated();
  } else if (act === 'task-toggle') {
    await toggleTask(t.dataset.id, t);
  } else if (act === 'task-note') {
    const task = S.tasks.find((x) => x.id === t.dataset.id);
    if (task) openTaskNoteSheet(task);
  } else if (act === 'task-edit') {
    const task = S.tasks.find((x) => x.id === t.dataset.id);
    if (task) openTaskSheet(task);
  } else if (act === 'sleep-open') {
    showTab('sleep');
  } else if (act === 'sleep-back') {
    S.selDate = S.today;
    showTab('today');
  } else if (act === 'sleep-setup') {
    openSleepSetup();
  } else if (act === 'sleep-repeat') {
    await repeatSleepWeek();
  } else if (act === 'sleep-norepeat') {
    try { localStorage.setItem('sleepRepeatAsked', t.dataset.w); } catch (err) { /* ок */ }
    rerender();
  } else if (act === 'sleep-log') {
    openSleepLogSheet();
  } else if (act === 'sleep-shifts') {
    openShiftsSheet();
  } else if (act === 'sleep-ideas') {
    openIdeasListSheet();
  } else if (act === 'sleep-day') {
    openSleepDaySheet(t.dataset.date);
  } else if (act === 'sleep-shift') {
    openShiftSheet();
  } else if (act === 'sleep-idea') {
    openIdeasSheet(null, S.today);
  } else if (act === 'idea-open') {
    const idea = S.ideas.find((x) => x.id === t.dataset.id);
    if (idea) openIdeaEdit(idea);
  } else if (act === 'j-filter') {
    if (S.jFilter === t.dataset.v) return;
    S.jFilter = t.dataset.v;
    rerender();
  } else if (act === 'j-search') {
    S.jSearch = !S.jSearch;
    if (!S.jSearch) S.jQuery = '';
    rerender();
    if (S.jSearch) currentView()?.querySelector('[data-jq]')?.focus();
  } else if (act === 'j-add') {
    openJournalSheet();
  } else if (act === 'j-open') {
    const { kind, ref } = t.dataset;
    if (kind === 'me') { const j = S.journal.find((x) => x.id === ref); if (j) openJournalSheet(j); }
    else if (kind === 'habit') { const [hid, date] = ref.split('|'); const hb = habitById(hid); if (hb) openNoteSheet(hb, date); }
    else if (kind === 'task') { const task = S.tasks.find((x) => x.id === ref); if (task) openTaskNoteSheet(task); }
  } else if (act === 'dismiss-install') {
    localStorage.setItem('installDismissed', '1');
    t.closest('.install').remove();
  } else if (act === 'install' && S.installPrompt) {
    S.installPrompt.prompt();
    S.installPrompt = null;
    t.closest('.install').remove();
  }
});

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  if (S.tab === b.dataset.tab) { currentView()?.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (b.dataset.tab === 'today') S.selDate = S.today;
  if (b.dataset.tab === 'plan') { S.planDate = S.today; S.planMode = 'day'; S.calOffset = 0; }
  showTab(b.dataset.tab);
}));
window.addEventListener('resize', () => { moveIndicator(); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (S.tab === 'today') rerender(); });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = todayKey();
  if (now !== S.today) {
    if (S.selDate === S.today) S.selDate = now;
    if (S.planDate === S.today) S.planDate = now;
    S.today = now;
    generateInstances().then(rerenderAnimated);
  }
});

function onServerMerge() {
  loadState().then(generateInstances).then(() => rerender());
}

onSyncStatus((s) => {
  S.sync = s;
  document.querySelectorAll('[data-sync-dot]').forEach((d) => { d.className = syncDotClass(); });
  document.querySelectorAll('[data-sync-text]').forEach((d) => { d.textContent = syncText(); });
});

/* ================= Старт ================= */
async function start() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-today') { S.selDate = S.today; showTab('today'); }
      if (e.data && e.data.type === 'open-tab' && TABS.includes(e.data.tab)) {
        if (e.data.tab === 'plan') { S.planMode = 'day'; S.planDate = S.today; }
        showTab(e.data.tab);
      }
    });
  }
  requestPersistence();
  await loadState();
  await generateInstances();
  let want = new URLSearchParams(location.search).get('tab');
  if (want === 'table' || want === 'stats') { S.progMode = want === 'table' ? 'table' : 'week'; want = 'progress'; }
  showTab(TABS.includes(want) ? want : 'today');
  initSync(onServerMerge);
  maybeShowIntro();
}
start();
