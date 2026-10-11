import { db, requestPersistence } from './db.js';
import { initSync, scheduleSync, syncNow, onSyncStatus, getUserId, adoptUserId } from './sync.js';
import { isIOS, isStandalone, getNotifySettings, setDaily, updateTime, ensureTaskPush } from './notify.js';

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
  sync: { state: 'idle', pending: 0, lastSync: null },
  installPrompt: null,
  // планувальник
  tasks: [],
  planMode: 'day',     // day | ahead | cal
  planDate: todayKey(),
  calOffset: 0
};

async function loadState() {
  const [habits, marks, tasks] = await Promise.all([db.getAll('habits'), db.getAll('marks'), db.getAll('tasks')]);
  S.habits = habits.filter((h) => !h.deleted).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  S.marks = new Map(marks.map((m) => [m.k, { value: m.value, amount: m.amount ?? null }]));
  S.tasks = tasks.filter((t) => !t.deleted);
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
const nextVal = (v) => (v === 0 ? 2 : v === 2 ? 1 : 0); // тап: виконано → мінімум → скинути

/* ================= Запис змін (спершу на телефон) ================= */
async function setMark(hid, date, value, amount = null) {
  const rec = { k: hid + '|' + date, habitId: hid, date, value, amount, updatedAt: Date.now(), dirty: true };
  S.marks.set(rec.k, { value, amount });
  await db.put('marks', rec);
  scheduleSync();
}
async function saveHabit(data) {
  const now = Date.now();
  const fields = { name: data.name, full: data.full, min: data.min, kind: data.kind === 'count' ? 'count' : 'check',
    perWeek: data.perWeek >= 1 && data.perWeek <= 6 ? data.perWeek : 7 };
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
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

/* ================= Навігація ================= */
const views = document.getElementById('views');
const TABS = ['today', 'plan', 'table', 'stats'];

function showTab(tab, { animate = true } = {}) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
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
function moveIndicator() {
  const ind = document.querySelector('.tab-indicator');
  const i = TABS.indexOf(S.tab);
  ind.style.transform = `translateX(${i * (ind.offsetWidth + 4)}px)`;
}
function currentView() { return views.querySelector('.view:not(.leave)'); }
function renderView(el = currentView()) {
  if (!el) return;
  if (el.dataset.view === 'today') renderToday(el);
  if (el.dataset.view === 'plan') renderPlan(el);
  if (el.dataset.view === 'table') renderTable(el);
  if (el.dataset.view === 'stats') renderStats(el);
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
  let head = `${counted} з ${hs.length} звичок зараховано`;
  let sub = 'Поганий день? Зроби мінімум — ланцюжок не порветься.';
  if (hs.length && full === hs.length) { head = 'Ідеальний день!'; sub = 'Усе виконано повністю. Так тримати.'; }
  else if (hs.length && counted === hs.length) { head = 'День зараховано'; sub = 'Ланцюжок цілий — навіть мінімум рахується.'; }
  if (!hs.length && weekly.length) {
    // лише тижневі звички: кільце показує прогрес тижня
    frac = weekly.reduce((s, h) => s + Math.min(1, weekDone(h, ws) / (weekNeed(h, ws) || 1)), 0) / weekly.length;
    head = `Тиждень: ${weeklyMet} з ${weekly.length} цілей`;
    sub = 'Тижневі звички роби в будь-які дні — головне встигнути до неділі.';
  } else if (weekly.length) {
    sub += ` Тижневі цілі: ${weeklyMet}/${weekly.length}.`;
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

function habitSub(h, v, date = S.selDate) {
  if (isCount(h)) {
    const a = amt(h.id, date);
    const u = h.unit ? ' ' + esc(h.unit) : '';
    if (a != null && a > 0) {
      const left = h.target - a;
      return `<b class="amt">${fmtNum(a)}</b> / ${fmtNum(h.target)}${u}` + (left > 0 ? ` · ще ${fmtNum(left)}` : ' · ціль ✓');
    }
    return `Ціль: ${fmtNum(h.target)}${u} · мін. ${fmtNum(minOf(h))}`;
  }
  if (v === 1) return 'Мінімум: ' + esc(h.min || '—');
  return 'Мета: ' + esc(h.full || '—') + (h.min ? ' · мін. ' + esc(h.min) : '');
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
          <span class="meta"><span class="name">${esc(h.name)}${weekLine(h)}</span><span class="sub">${habitSub(h, v)}</span></span>
          <span class="streak">${I.flame}<span>${streakLabel(h)}</span></span>
          <span class="check">${checkInner(h, v)}</span>
          ${isCount(h) ? `<span class="hbar"><i style="width:${barWidth(h)}%"></i></span>` : ''}</button>`;
      }).join('')}</div>
      <div class="hint">Тап — відмітити (у звичках з кількістю — ввести, скільки зроблено).<br>Утримуй звичку, щоб змінити або видалити.</div>`
    : S.habits.length
      ? `<div class="empty glass"><p>Цього дня звичок ще не було.</p></div>`
      : `<div class="empty glass">
          <h2>Почнімо з однієї звички</h2>
          <p>Для кожної задай повну мету і мінімум — на дні, коли зовсім немає сил.</p>
          <div class="chips">${TEMPLATES.map((tp, i) => `<button class="chip glass press" data-act="template" data-i="${i}">${esc(tp.name)}</button>`).join('')}</div>
          <button class="btn primary press" data-act="add">${I.plus.replace('<svg', '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')}Своя звичка</button>
        </div>`;

  el.innerHTML = `
    <div class="head">
      <div><div class="eyebrow"><span class="${syncDotClass()}" data-sync-dot></span>${esc(fmtLong.format(parseKey(date)))}</div><h1>${title}</h1></div>
      <div class="head-actions">
        <button class="icon-btn glass press" data-act="settings" aria-label="Налаштування">${I.gear}</button>
        <button class="icon-btn glass press" data-act="add" aria-label="Додати звичку">${I.plus}</button>
      </div>
    </div>
    ${install}
    <div class="week">${week.join('')}</div>
    <div class="progress-card glass${sum.total && sum.counted === sum.total ? ' done' : ''}" data-progress>
      <div class="ring"><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/><circle class="bar" cx="60" cy="60" r="52" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}" data-ring/></svg>
        <div class="val"><div><b data-pct>0%</b><small>дня</small></div></div></div>
      <div class="txt"><b data-headline>${sum.any ? sum.head : 'Ще немає звичок'}</b><span data-sub>${sum.any ? sum.sub : 'Додай першу — і відмічай щодня.'}</span></div>
    </div>
    ${list}`;

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

function tableKpis(mi) {
  let counted = 0, eligible = 0, sum = 0, mins = 0;
  mi.keys.forEach((d) => {
    if (d > S.today) return;
    const sc = dayScore(d);
    if (sc === null) return;
    eligible++; sum += sc;
    if (dayCounted(d)) counted++;
    activeOn(d).forEach((h) => { if (val(h.id, d) === 1) mins++; });
  });
  return `
    <div class="kpi glass"><b class="lime">${counted}/${eligible}</b><span>днів усе зараховано</span></div>
    <div class="kpi glass"><b>${eligible ? Math.round(sum / eligible * 100) : 0}%</b><span>середній день</span></div>
    <div class="kpi glass"><b>${mins}</b><span>разів «мінімум»</span></div>`;
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
    else cls += ' v' + val(h.id, d);
    if (d === S.today) cls += ' today';
    return `<button class="${cls}" data-act="cell" data-id="${h.id}" data-date="${d}" aria-label="${esc(h.name)}, ${parseKey(d).getDate()}"></button>`;
  }).join('')}</div>`).join('');
  const bars = mi.keys.map((d, i) => {
    const raw = d <= S.today ? dayScore(d) : null;
    const sc = raw || 0;
    return `<div class="bw${d === S.today ? ' today' : ''}" data-bar="${d}"><i style="--i:${i};height:${Math.max(3, Math.round(sc * 28))}px;${raw === null ? 'background:rgba(255,255,255,.1)' : ''}"></i></div>`;
  }).join('');

  el.innerHTML = `
    <div class="month-head">
      <button class="icon-btn glass press" data-act="month" data-d="-1" aria-label="Попередній місяць" ${prevDisabled ? 'disabled' : ''}>${I.left}</button>
      <div class="mid"><div class="eyebrow">Таблиця звичок</div><h1>${esc(fmtMonth.format(mi.first).replace(' р.', ''))}</h1></div>
      <button class="icon-btn glass press" data-act="month" data-d="1" aria-label="Наступний місяць" ${S.monthOffset >= 0 ? 'disabled' : ''}>${I.right}</button>
    </div>
    <div class="kpis stagger" data-kpis>${tableKpis(mi)}</div>
    ${hs.length ? `
    <div class="grid-card glass">
      <div class="grid-names">
        <div style="height:34px"></div>
        ${hs.map((h) => `<div class="nm"><b>${esc(h.name)}</b><span data-rs="${h.id}">${rowScore(h, mi)}</span></div>`).join('')}
        <div class="grid-labels">День, %</div>
      </div>
      <div class="grid-scroll" data-gscroll>
        <div class="grid-cols">
          <div class="grow ghead">${head}</div>
          ${rows}
          <div class="grow gbars">${bars}</div>
        </div>
      </div>
    </div>
    <div class="legend"><span><i class="l2"></i>Повністю</span><span><i class="l1"></i>Мінімум</span><span><i class="l0"></i>Пропуск</span></div>
    <div class="hint">Свайпни таблицю вбік. Тап по клітинці змінює відмітку заднім числом.</div>`
    : `<div class="empty glass"><p>Цього місяця звичок ще не було.</p></div>`}`;

  const sc = el.querySelector('[data-gscroll]');
  if (sc && S.monthOffset === 0) {
    const idx = mi.keys.indexOf(S.today);
    sc.scrollLeft = Math.max(0, idx * 30 - sc.clientWidth / 2);
  }
}

/* ================= Екран «Статистика» ================= */
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
  let saved = 0;
  days.forEach((d) => activeOn(d).forEach((h) => { if (val(h.id, d) === 1) saved++; }));

  const bars = days.map((d, i) => {
    const hs = dailyOn(d);
    const f = hs.filter((h) => val(h.id, d) === 2).length;
    const m = hs.filter((h) => val(h.id, d) === 1).length;
    const n = hs.length || 1;
    const label = S.period === 'week' ? WD_SHORT[parseKey(d).getDay()] : (i % 5 === 0 || d === S.today ? String(parseKey(d).getDate()) : '');
    return `<div class="bcol${d === S.today ? ' today' : ''}"><div class="btrack">
      <i class="m" style="--i:${i};height:${Math.round(m / n * 88)}px"></i><i class="f" style="--i:${i};height:${Math.round(f / n * 88)}px"></i>
      </div><small>${label || '&nbsp;'}</small></div>`;
  }).join('');

  const last7 = periodDays('week', S.today);
  const habits = S.habits.map((h) => {
    let any = 0, eligible = 0;
    days.forEach((d) => { if (d >= h.start) { eligible++; if (val(h.id, d) > 0) any++; } });
    // для тижневих звичок очікується perWeek разів на кожні 7 днів
    const expected = isDaily(h) ? eligible : Math.max(1, Math.round(perWeek(h) * eligible / 7));
    const pct = eligible ? Math.min(100, Math.round(any / expected * 100)) : 0;
    const dots = last7.map((d) => `<i class="${d < h.start ? 'na' : 'v' + val(h.id, d)}"></i>`).join('');
    const tag = isDaily(h) ? '' : `<small class="fq">${perWeek(h)}×/тиж</small>`;
    return `<div class="hrow"><span class="n">${esc(h.name)}${tag}</span><span class="dots">${dots}</span><span class="p">${pct}%</span></div>`;
  }).join('');

  const range = S.period === 'week'
    ? `${parseKey(days[0]).getDate()} – ${fmtDayMonth.format(parseKey(S.today))}`
    : cap(fmtMonth.format(parseKey(S.today)).replace(' р.', ''));

  el.innerHTML = `
    <div class="head stack">
      <div><div class="eyebrow">${esc(range)}</div><h1>Статистика</h1></div>
      <div class="seg glass" role="tablist" aria-label="Період">
        <div class="knob"></div>
        <button role="tab" data-act="period" data-p="week" class="${S.period === 'week' ? 'on' : ''}" aria-selected="${S.period === 'week'}">Тиждень</button>
        <button role="tab" data-act="period" data-p="month" class="${S.period === 'month' ? 'on' : ''}" aria-selected="${S.period === 'month'}">Місяць</button>
      </div>
    </div>
    <div class="stagger" style="display:flex;flex-direction:column;gap:16px">
      <div class="hero glass" style="--i:0">
        <div class="big"><span>Виконання за період</span><b data-total>0%</b><em>${esc(delta)}</em></div>
        <div class="side">
          <div class="mini-card"><b>${best.n} ${best.weeks ? plural(best.n, 'тиждень', 'тижні', 'тижнів') : plural(best.n, 'день', 'дні', 'днів')}</b><span>${best.n ? 'рекорд: ' + esc(best.name) : 'найдовший ланцюжок'}</span></div>
          <div class="mini-card"><b>${saved} ${plural(saved, 'раз', 'рази', 'разів')}</b><span>врятовано мінімумом</span></div>
        </div>
      </div>
      <div class="chart glass" style="--i:1">
        <div class="chart-top"><b>По днях</b><div class="legend" style="padding:0;font-size:11px;gap:10px"><span><i class="l2"></i>Повністю</span><span><i class="l1"></i>Мінімум</span></div></div>
        <div class="bars">${bars}</div>
      </div>
      ${S.habits.length ? `<div class="hlist glass" style="--i:2"><div class="top">Звички<span>останні 7 днів</span></div>${habits}</div>` : ''}
    </div>`;

  requestAnimationFrame(() => {
    placeKnob(el);
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
function closeSheet(instant = false) {
  const w = sheetRoot.querySelector('.sheet-wrap');
  if (!w) return;
  if (instant || reduceMotion()) { w.remove(); return; }
  w.classList.add('closing');
  setTimeout(() => w.remove(), 280);
}

function openHabitSheet(h = null) {
  const v = h || { name: '', full: '', min: '', kind: 'count', target: '', minAmount: '', unit: '' };
  let kind = isCount(v) || (!h && v.kind === 'count') ? 'count' : 'check';
  openSheet(`
    <h2>${h ? 'Редагувати звичку' : 'Нова звичка'}</h2>
    <div class="field"><label for="f-name">Назва</label><input id="f-name" maxlength="40" placeholder="Напр. Читання" value="${esc(v.name)}" autocomplete="off"></div>
    <div class="field"><label>Як відмічати</label>
      <div class="seg glass" role="tablist" data-kind-seg>
        <div class="knob"></div>
        <button type="button" role="tab" data-kind="count">Кількість</button>
        <button type="button" role="tab" data-kind="check">Так / ні</button>
      </div>
      <small data-kind-hint></small>
    </div>
    <div class="field"><label>Як часто</label>
      <div class="freq" role="radiogroup" aria-label="Як часто" data-freq>
        ${[7, 1, 2, 3, 4, 5, 6].map((n) => `<button type="button" role="radio" class="glass press" data-pw="${n}">${n === 7 ? 'Щодня' : n + '×'}</button>`).join('')}
      </div>
      <small data-freq-hint></small>
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
      <div class="field"><label for="f-full">Повна мета</label><input id="f-full" maxlength="40" placeholder="Напр. лягти до 23:00" value="${esc(isCount(v) ? '' : v.full)}" autocomplete="off"></div>
      <div class="field"><label for="f-min">Мінімум на поганий день</label><input id="f-min" maxlength="40" placeholder="Напр. лягти до 00:00" value="${esc(isCount(v) ? '' : v.min)}" autocomplete="off"><small>Настільки мало, щоб це можна було зробити за будь-якого настрою.</small></div>
    </div>
    <button class="btn primary block press" data-save>${h ? 'Зберегти' : 'Додати'}</button>
    ${h ? '<button class="btn danger block press" data-del>Видалити звичку</button>' : ''}
  `, (sheet) => {
    const name = sheet.querySelector('#f-name');
    const seg = sheet.querySelector('[data-kind-seg]');
    const applyKind = () => {
      seg.querySelectorAll('button').forEach((b) => { const on = b.dataset.kind === kind; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      sheet.querySelector('[data-kind-count]').hidden = kind !== 'count';
      sheet.querySelector('[data-kind-check]').hidden = kind !== 'check';
      sheet.querySelector('[data-kind-hint]').textContent = kind === 'count'
        ? 'Вводиш, скільки зробив: 19 з 20 сторінок зарахується майже як повний день.'
        : 'Просто відмічаєш: виконано, мінімум або ні.';
      placeKnob(sheet);
    };
    seg.addEventListener('click', (e) => { const b = e.target.closest('[data-kind]'); if (b) { kind = b.dataset.kind; applyKind(); } });
    requestAnimationFrame(applyKind);
    let pw = h ? perWeek(h) : 7;
    const freq = sheet.querySelector('[data-freq]');
    const applyFreq = () => {
      freq.querySelectorAll('[data-pw]').forEach((b) => { const on = Number(b.dataset.pw) === pw; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
      sheet.querySelector('[data-freq-hint]').textContent = pw === 7
        ? 'Щодня — рахується в щоденний відсоток і ланцюжок днів.'
        : `${pw} ${plural(pw, 'раз', 'рази', 'разів')} на тиждень, у будь-які дні. Інші дні не рахуються пропуском, а ланцюжок рахується в тижнях.`;
    };
    freq.addEventListener('click', (e) => { const b = e.target.closest('[data-pw]'); if (b) { pw = Number(b.dataset.pw); applyFreq(); } });
    applyFreq();
    if (!h) setTimeout(() => name.focus(), 350);
    const bad = (el) => { el.focus(); el.style.borderColor = '#FF8A80'; };
    sheet.querySelector('[data-save]').addEventListener('click', async () => {
      const n = name.value.trim();
      if (!n) return bad(name);
      const data = { id: h?.id, name: n, kind, perWeek: pw };
      if (kind === 'count') {
        const tEl = sheet.querySelector('#f-target'), mEl = sheet.querySelector('#f-minamt');
        const target = parseNum(tEl.value);
        if (!target) return bad(tEl);
        let minAmount = parseNum(mEl.value);
        if (minAmount == null || minAmount <= 0) minAmount = Math.max(1, Math.round(target * 0.1));
        if (minAmount > target) return bad(mEl);
        Object.assign(data, { target, minAmount, unit: sheet.querySelector('#f-unit').value.trim() });
      } else {
        Object.assign(data, { full: sheet.querySelector('#f-full').value.trim(), min: sheet.querySelector('#f-min').value.trim() });
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
    <button class="btn primary block press" data-ok>Зберегти</button>
    <button class="btn block press" data-clear style="color:var(--muted)">Скинути</button>
  `, (sheet) => {
    const input = sheet.querySelector('[data-amount]');
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
      await setMark(h.id, date, valueForAmount(h, value), value > 0 ? value : null);
      closeSheet();
      if (onDone) onDone();
    };
    sheet.querySelector('[data-ok]').addEventListener('click', () => save(a));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(a); });
    sheet.querySelector('[data-clear]').addEventListener('click', () => save(0));
    paint();
  });
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

async function openSettings() {
  const ns = await getNotifySettings();
  const uid = await getUserId();
  const needInstall = isIOS() && !isStandalone();
  openSheet(`
    <h2>Налаштування</h2>
    <div class="set-group">
      <div class="set-row"><div class="l"><b>Нагадування про звички</b><span>${needInstall ? 'Спершу встанови застосунок на початковий екран' : 'Якщо до цього часу не все відмічено'}</span></div>
        <button class="switch" role="switch" aria-checked="${ns.enabled && ns.daily}" aria-label="Нагадування про звички" data-notify></button></div>
      <div class="set-row"><div class="l"><b>Час</b></div><input type="time" value="${esc(ns.time)}" data-time aria-label="Час нагадування"></div>
    </div>
    <div class="set-group">
      <div class="set-row"><div class="l"><b>Синхронізація</b><span data-sync-text>${esc(syncText())}</span></div>
        <button class="small-btn press" data-sync-now>Зараз</button></div>
      <div class="set-row"><div class="l"><b>Код синхронізації</b><span class="code">${esc(uid)}</span></div>
        <button class="small-btn press" data-copy>Копіювати</button></div>
      <div class="set-row"><div class="l" style="flex:1"><b>Підключити інший пристрій</b><span>Встав код з іншого телефона, щоб бачити ті самі звички</span></div></div>
      <div class="set-row" style="padding-top:0"><input class="code-in" data-code placeholder="u-…" style="flex:1;min-width:0;min-height:40px;padding:0 12px;border-radius:12px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);font-size:16px" autocomplete="off" autocapitalize="off"><button class="small-btn press" data-adopt>Підключити</button></div>
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
const ISUN = '<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICLOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

const relDay = (d) => (d === S.today ? 'Сьогодні' : d === addDays(S.today, 1) ? 'Завтра' : d === addDays(S.today, -1) ? 'Вчора' : cap(fmtWeekday.format(parseKey(d))));
const onDay = (d) => (d === S.today ? 'на сьогодні' : d === addDays(S.today, 1) ? 'на завтра' : 'на ' + fmtDayMonth.format(parseKey(d)));
const chipDay = (d) => (d === S.today ? 'Сьогодні' : d === addDays(S.today, 1) ? 'Завтра' : `${WD_SHORT[parseKey(d).getDay()]}, ${parseKey(d).getDate()}`);
const tasksOn = (d) => S.tasks.filter((t) => t.date === d);
// Невиконане з минулих днів автоматично показується в «Сьогодні» як «Перенесено»
const carriedTasks = () => S.tasks.filter((t) => t.date < S.today && !t.done).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
const byTime = (a, b) => ((a.time || '99') < (b.time || '99') ? -1 : (a.time || '99') > (b.time || '99') ? 1 : a.order - b.order);
function dayState(d) {
  const l = tasksOn(d);
  if (!l.length) return null;
  const open = l.filter((t) => !t.done).length;
  return { total: l.length, open, cls: !open ? 'done' : d < S.today ? 'late' : 'open' };
}

async function saveTask(data) {
  const now = Date.now();
  let t = data.id ? S.tasks.find((x) => x.id === data.id) : null;
  const fields = { title: data.title, date: data.date, time: data.time || '', remind: !!(data.remind && data.time) };
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
  const m = S.planMode;
  const b = (k, label, extra = '') => `<button role="tab" data-act="plan-mode" data-m="${k}" class="${m === k ? 'on' : ''}" aria-selected="${m === k}" ${extra}>${label}</button>`;
  return `<div class="plan-top">
    <div class="eyebrow"><span class="${syncDotClass()}" data-sync-dot></span>${esc(eyebrow)}</div>
    <div class="head plan-head"><h1>${esc(title)}</h1>
      <div class="pseg glass" role="tablist" aria-label="Вигляд плану">${b('day', 'День')}${b('ahead', 'Наперед')}${b('cal', ICAL, 'aria-label="Календар"')}</div>
    </div>
  </div>`;
}

function taskRow(t, i, { carried = false, compact = false } = {}) {
  const meta = carried ? 'Перенесено ' + (t.date === addDays(S.today, -1) ? 'з учора' : 'з ' + fmtShortDM.format(parseKey(t.date))) : '';
  return `<div class="task${compact ? ' compact' : ' glass'}${t.done ? ' done' : ''}${carried ? ' late' : ''}" data-task="${t.id}" style="--i:${i}">
    <button class="tcheck" data-act="task-toggle" data-id="${t.id}" aria-label="${t.done ? 'Зняти позначку' : 'Виконано'}: ${esc(t.title)}">${I.check}</button>
    <button class="tbody" data-act="task-edit" data-id="${t.id}" aria-label="Змінити: ${esc(t.title)}">
      <span class="tt">${esc(t.title)}</span>${meta ? `<span class="tm">${meta}</span>` : ''}
    </button>
    ${t.time ? `<span class="ttime">${t.remind ? IBELL : ''}${t.time}</span>` : ''}
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
    ? `<div class="tsec"><div class="tsec-h${opts.carried ? ' late' : ''}">${title}</div>${items.map((t) => taskRow(t, i++, opts)).join('')}</div>` : '');

  el.innerHTML = `
    ${planHead(fmtLong.format(parseKey(date)), relDay(date))}
    <div class="pstrip">${strip.join('')}<button class="pday cal" data-act="plan-mode" data-m="cal" aria-label="Відкрити календар">${ICAL}</button></div>
    ${total ? `<div class="pprog"><span>Виконано ${done} з ${total}</span><div class="pbar"><i style="width:${Math.round(done / total * 100)}%"></i></div></div>` : ''}
    <div class="stagger tlist">
      ${section('Перенесено', carried, { carried: true })}
      ${section('За часом', timed)}
      ${section('Будь-коли', any)}
    </div>
    ${total ? '' : `<div class="empty glass">${ISUN}<h2>${date < S.today ? 'Нічого не було' : 'Вільний день'}</h2><p>${date < S.today ? 'На цей день справ не планувалось.' : 'На цей день ще нічого не заплановано. Додай завдання знизу.'}</p></div>`}`;
}

function renderPlanAhead(el) {
  const carried = carriedTasks();
  const dates = [...new Set(S.tasks.filter((t) => t.date >= S.today).map((t) => t.date))].sort();
  if (carried.length && !dates.includes(S.today)) dates.unshift(S.today);
  let i = 0;
  const groups = dates.slice(0, 40).map((d, gi) => {
    const items = (d === S.today ? carried : []).concat(tasksOn(d).sort(byTime));
    const open = items.filter((t) => !t.done).length;
    const sub = d === S.today || d === addDays(S.today, 1) ? fmtWdShortDate.format(parseKey(d)) : fmtDayMonth.format(parseKey(d));
    return `<div class="tgroup glass" style="--i:${gi}">
      <div class="tgroup-h"><b class="${d === S.today ? 'lime' : ''}">${relDay(d)}</b><span>${esc(sub)}</span><em>${open ? open + ' ' + plural(open, 'справа', 'справи', 'справ') : 'усе ✓'}</em></div>
      ${items.map((t) => taskRow(t, i++, { carried: t.date < S.today, compact: true })).join('')}
    </div>`;
  }).join('');
  const last = dates.length ? dates[Math.min(dates.length, 40) - 1] : null;
  el.innerHTML = `
    ${planHead(last && last !== S.today ? `${fmtShortDM.format(parseKey(S.today))} – ${fmtShortDM.format(parseKey(last))}` : 'Найближчі справи', 'Наперед')}
    ${groups ? `<div class="stagger tgroups">${groups}</div>`
      : `<div class="empty glass">${ISUN}<h2>Наперед порожньо</h2><p>Додай завдання на будь-який день — вони з'являться тут списком по днях.</p></div>`}`;
}

function renderPlanCal(el) {
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
    const dots = st ? Array.from({ length: Math.min(3, st.total) }, () => `<i class="${st.cls}"></i>`).join('') : '';
    cells.push(`<button class="ccell${st ? ' has' : ''}${d === S.today ? ' today' : ''}${d < S.today ? ' past' : ''}" data-act="plan-open" data-date="${d}" aria-label="${esc(fmtLong.format(parseKey(d)))}${st ? ', завдань: ' + st.total : ', вільно'}">
      <span>${n}</span><span class="cdots">${dots}</span></button>`);
  }
  const upcoming = S.tasks.filter((t) => !t.done && t.date >= S.today).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byTime(a, b)))[0];
  const nextCard = upcoming ? `<button class="nextcard glass press" data-act="plan-open" data-date="${upcoming.date}">
      <span class="nc-date"><small>${WD_SHORT[parseKey(upcoming.date).getDay()]}</small><b>${parseKey(upcoming.date).getDate()}</b></span>
      <span class="nc-txt"><small>Найближче · ${esc(relDay(upcoming.date).toLowerCase())}</small><b>${upcoming.time ? upcoming.time + ' · ' : ''}${esc(upcoming.title)}</b></span>
      ${I.right}</button>` : '';
  el.innerHTML = `
    ${planHead('Календар справ · ' + first.getFullYear(), cap(new Intl.DateTimeFormat('uk', { month: 'long' }).format(first)))}
    <div class="calcard glass">
      <div class="cal-nav">
        <button class="icon-btn small press" data-act="cal-nav" data-d="-1" aria-label="Попередній місяць">${I.left}</button>
        <span>${busy ? `${busy} ${plural(busy, 'день', 'дні', 'днів')} зі справами · ${total} ${plural(total, 'завдання', 'завдання', 'завдань')}` : 'Справ у цьому місяці немає'}</span>
        <button class="icon-btn small press" data-act="cal-nav" data-d="1" aria-label="Наступний місяць">${I.right}</button>
      </div>
      <div class="cgrid wds"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span class="we">Сб</span><span class="we">Нд</span></div>
      <div class="cgrid">${cells.join('')}</div>
    </div>
    <div class="legend"><span><i class="l-open"></i>Заплановано</span><span><i class="l-late"></i>Не виконано</span><span><i class="l-done"></i>Усе зроблено</span></div>
    ${nextCard}`;
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
  let remind = task ? !!task.remind : false;
  const t0 = parseKey(S.today);
  const monthOff = (d) => { const p = parseKey(d); return (p.getFullYear() - t0.getFullYear()) * 12 + p.getMonth() - t0.getMonth(); };
  let calOff = Math.max(0, monthOff(sel));
  const nextMon = addDays(S.today, 7 - ((t0.getDay() + 6) % 7));
  const chipDates = [...new Set([S.today, addDays(S.today, 1), addDays(S.today, 2), nextMon])];

  openSheet(`
    <h2>${task ? 'Змінити завдання' : 'Нове завдання'}</h2>
    <label for="t-title" class="sr-only">Що треба зробити</label>
    <input id="t-title" class="big-input" maxlength="120" placeholder="Що треба зробити?" value="${esc(task ? task.title : '')}" autocomplete="off">
    <div class="field"><label>Коли</label><div class="dchips" data-chips></div></div>
    <div class="mcal" data-cal></div>
    <div class="tpills"><div class="tpill" data-timebox></div><button type="button" class="tpill" data-remind></button></div>
    <button class="btn primary block press" data-save></button>
    ${task ? `<div class="row-actions">${task.done ? '' : `<button class="btn block glass press" data-tomorrow>На завтра</button>`}<button class="btn danger block press" data-del>Видалити</button></div>` : ''}
  `, (sheet) => {
    const title = sheet.querySelector('#t-title');
    const paint = () => {
      sheet.querySelector('[data-chips]').innerHTML = chipDates.map((d) =>
        `<button type="button" class="chip glass${d === sel ? ' on' : ''}" data-pick="${d}" aria-pressed="${d === sel}">${chipDay(d)}</button>`).join('');
      // календар
      const first = new Date(t0.getFullYear(), t0.getMonth() + calOff, 1);
      const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const off = (first.getDay() + 6) % 7;
      let cells = '';
      for (let k = 0; k < off; k++) cells += '<span></span>';
      for (let n = 1; n <= days; n++) {
        const d = keyOf(new Date(first.getFullYear(), first.getMonth(), n));
        const st = dayState(d);
        cells += `<button type="button" class="mc${d === sel ? ' on' : ''}${d === S.today ? ' today' : ''}${st && d >= S.today ? ' has' : ''}" data-pick="${d}" ${d < S.today ? 'disabled' : ''} aria-label="${esc(fmtLong.format(parseKey(d)))}">${n}</button>`;
      }
      sheet.querySelector('[data-cal]').innerHTML = `
        <div class="mc-head"><button type="button" class="icon-btn small" data-cal-d="-1" ${calOff <= 0 ? 'disabled' : ''} aria-label="Попередній місяць">${I.left}</button>
          <b>${esc(cap(fmtMonth.format(first).replace(' р.', '')))}</b>
          <button type="button" class="icon-btn small" data-cal-d="1" aria-label="Наступний місяць">${I.right}</button></div>
        <div class="mc-grid wds"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Нд</span></div>
        <div class="mc-grid">${cells}</div>`;
      // час і нагадування
      sheet.querySelector('[data-timebox]').innerHTML = time
        ? `${ICLOCK}<input type="time" value="${time}" data-time aria-label="Час"><button type="button" class="tclear" data-clear-time aria-label="Без часу">${I.x}</button>`
        : `<button type="button" class="tadd" data-add-time>${ICLOCK}<span>Додати час</span></button>`;
      sheet.querySelector('[data-timebox]').classList.toggle('on', !!time);
      const rb = sheet.querySelector('[data-remind]');
      rb.classList.toggle('on', remind && !!time);
      rb.innerHTML = `${IBELL}<span>${remind && time ? 'Нагадаю о ' + minusMin(time, 15) : 'Нагадати'}</span>`;
      sheet.querySelector('[data-save]').textContent = (task ? 'Зберегти ' : 'Додати ') + onDay(sel);
    };
    sheet.addEventListener('click', (e) => {
      const p = e.target.closest('[data-pick]');
      if (p && !p.disabled) { sel = p.dataset.pick; calOff = Math.max(0, monthOff(sel)); paint(); return; }
      const cd = e.target.closest('[data-cal-d]');
      if (cd && !cd.disabled) { calOff = Math.max(0, calOff + Number(cd.dataset.calD)); paint(); return; }
      if (e.target.closest('[data-add-time]')) { time = '09:00'; paint(); setTimeout(() => sheet.querySelector('[data-time]')?.focus(), 50); return; }
      if (e.target.closest('[data-clear-time]')) { time = ''; remind = false; paint(); return; }
      if (e.target.closest('[data-remind]')) { remind = !remind; if (remind && !time) time = '09:00'; paint(); }
    });
    sheet.addEventListener('change', (e) => { if (e.target.matches('[data-time]')) { time = e.target.value; paint(); } });
    paint();
    if (!task) setTimeout(() => title.focus(), 350);
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') sheet.querySelector('[data-save]').click(); });

    sheet.querySelector('[data-save]').addEventListener('click', async () => {
      const txt = title.value.trim();
      if (!txt) { title.focus(); title.style.borderColor = '#FF8A80'; return; }
      const saved = await saveTask({ id: task?.id, title: txt, date: sel, time, remind });
      closeSheet();
      toast(task ? 'Збережено' : `Додано ${onDay(saved.date)}`);
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
  setTimeout(() => {
    rerender();
    if (!wasAllDone && todayAllDone() && S.planMode !== 'cal') {
      confetti(currentView()?.querySelector('.pprog') || null);
      toast('Усі справи на сьогодні зроблено');
    }
  }, 280);
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
views.addEventListener('contextmenu', (e) => { if (e.target.closest('.habit')) e.preventDefault(); });

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
    const v = nextVal(val(id, date));
    ripple(t, e);
    popEl(t.querySelector('.check'));
    await setMark(id, date, v);
    updateTodayDynamic(t);
    celebrate(hb, date, before, t);
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
    if (S.planMode === t.dataset.m) return;
    S.planMode = t.dataset.m;
    if (S.planMode === 'cal') { const p = parseKey(S.planDate), n = parseKey(S.today); S.calOffset = (p.getFullYear() - n.getFullYear()) * 12 + p.getMonth() - n.getMonth(); }
    rerenderAnimated();
  } else if (act === 'plan-day') {
    S.planDate = t.dataset.date;
    rerenderAnimated();
  } else if (act === 'plan-open') {
    S.planDate = t.dataset.date;
    S.planMode = 'day';
    rerenderAnimated();
  } else if (act === 'cal-nav') {
    S.calOffset += Number(t.dataset.d);
    rerenderAnimated();
  } else if (act === 'task-toggle') {
    await toggleTask(t.dataset.id, t);
  } else if (act === 'task-edit') {
    const task = S.tasks.find((x) => x.id === t.dataset.id);
    if (task) openTaskSheet(task);
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
  if (b.dataset.tab === 'plan') { S.planDate = S.today; S.planMode = 'day'; }
  showTab(b.dataset.tab);
}));
window.addEventListener('resize', () => { moveIndicator(); if (S.tab === 'stats') placeKnob(currentView()); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (S.tab === 'today') rerender(); });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = todayKey();
  if (now !== S.today) {
    if (S.selDate === S.today) S.selDate = now;
    if (S.planDate === S.today) S.planDate = now;
    S.today = now;
    rerenderAnimated();
  }
});

function onServerMerge() {
  loadState().then(() => rerender());
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
  const want = new URLSearchParams(location.search).get('tab');
  showTab(TABS.includes(want) ? want : 'today');
  initSync(onServerMerge);
}
start();
