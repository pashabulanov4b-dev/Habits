import { db, requestPersistence } from './db.js';
import { initSync, scheduleSync, syncNow, onSyncStatus, getUserId, adoptUserId } from './sync.js';
import { isIOS, isStandalone, getNotifySettings, enableNotifications, disableNotifications, updateTime } from './notify.js';

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
  installPrompt: null
};

async function loadState() {
  const [habits, marks] = await Promise.all([db.getAll('habits'), db.getAll('marks')]);
  S.habits = habits.filter((h) => !h.deleted).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  S.marks = new Map(marks.map((m) => [m.k, m.value]));
}

const val = (hid, date) => S.marks.get(hid + '|' + date) || 0;
const activeOn = (date) => S.habits.filter((h) => h.start <= date);

function dayScore(date) {
  const hs = activeOn(date);
  if (!hs.length) return null;
  let s = 0;
  hs.forEach((h) => { const v = val(h.id, date); s += v === 2 ? 1 : v === 1 ? 0.5 : 0; });
  return s / hs.length;
}
function dayCounted(date) {
  const hs = activeOn(date);
  return hs.length > 0 && hs.every((h) => val(h.id, date) > 0);
}
function streakOf(h) {
  let d = S.today;
  if (!val(h.id, d)) d = addDays(d, -1);
  let n = 0;
  while (d >= h.start && val(h.id, d) > 0) { n++; d = addDays(d, -1); }
  return n;
}
function longestOf(h) {
  let best = 0, run = 0;
  for (let d = h.start; d <= S.today; d = addDays(d, 1)) {
    if (val(h.id, d) > 0) { run++; if (run > best) best = run; } else run = 0;
  }
  return best;
}
const nextVal = (v) => (v === 0 ? 2 : v === 2 ? 1 : 0); // тап: виконано → мінімум → скинути

/* ================= Запис змін (спершу на телефон) ================= */
async function setMark(hid, date, value) {
  const rec = { k: hid + '|' + date, habitId: hid, date, value, updatedAt: Date.now(), dirty: true };
  S.marks.set(rec.k, value);
  await db.put('marks', rec);
  scheduleSync();
}
async function saveHabit(data) {
  const now = Date.now();
  let h = data.id ? S.habits.find((x) => x.id === data.id) : null;
  if (h) {
    Object.assign(h, { name: data.name, full: data.full, min: data.min, updatedAt: now, dirty: true });
  } else {
    const maxOrder = S.habits.reduce((m, x) => Math.max(m, x.order), 0);
    h = { id: 'h-' + now.toString(36) + Math.random().toString(36).slice(2, 7), name: data.name, full: data.full, min: data.min,
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
const TABS = ['today', 'table', 'stats'];

function showTab(tab, { animate = true } = {}) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  moveIndicator();
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
  if (el.dataset.view === 'table') renderTable(el);
  if (el.dataset.view === 'stats') renderStats(el);
}
function rerender() {
  const el = currentView();
  if (!el) return;
  const top = el.scrollTop;
  el.classList.remove('enter');
  renderView(el);
  el.scrollTop = top;
}

/* ================= Екран «Сьогодні» ================= */
const RING_C = 2 * Math.PI * 52;
const TEMPLATES = [
  ['Читання', '20 сторінок', '1 сторінка'],
  ['Спорт', '30 хв тренування', '10 віджимань'],
  ['Вода', '8 склянок', '4 склянки'],
  ['Сон до 23:00', 'лягти до 23:00', 'лягти до 00:00'],
  ['Медитація', '10 хвилин', '3 глибокі вдихи'],
  ['Іноземна мова', '30 хв уроку', '10 нових слів']
];

function syncDotClass() { return 'sync-dot ' + (S.sync.state === 'syncing' ? 'syncing' : S.sync.state === 'offline' ? 'offline' : S.sync.state === 'error' ? 'error' : ''); }

function todaySummary() {
  const date = S.selDate;
  const hs = activeOn(date);
  const counted = hs.filter((h) => val(h.id, date) > 0).length;
  const full = hs.filter((h) => val(h.id, date) === 2).length;
  const frac = dayScore(date) ?? 0;
  let head = `${counted} з ${hs.length} звичок зараховано`;
  let sub = 'Поганий день? Зроби мінімум — ланцюжок не порветься.';
  if (hs.length && full === hs.length) { head = 'Ідеальний день!'; sub = 'Усе виконано повністю. Так тримати.'; }
  else if (hs.length && counted === hs.length) { head = 'День зараховано'; sub = 'Ланцюжок цілий — навіть мінімум рахується.'; }
  return { frac, head, sub, counted, total: hs.length };
}

function habitSub(h, v) {
  if (v === 1) return 'Мінімум: ' + esc(h.min || '—');
  return 'Мета: ' + esc(h.full || '—') + (h.min ? ' · мін. ' + esc(h.min) : '');
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
        return `<button class="habit glass v${v}" data-act="habit" data-id="${h.id}" style="--i:${i}" aria-label="${esc(h.name)}">
          <span class="meta"><span class="name">${esc(h.name)}</span><span class="sub">${habitSub(h, v)}</span></span>
          <span class="streak">${I.flame}<span>${streakOf(h)}</span></span>
          <span class="check">${I.check}<span class="min">МІН</span></span></button>`;
      }).join('')}</div>
      <div class="hint">Тап — виконано, ще тап — мінімум, ще — скинути.<br>Утримуй звичку, щоб змінити або видалити.</div>`
    : S.habits.length
      ? `<div class="empty glass"><p>Цього дня звичок ще не було.</p></div>`
      : `<div class="empty glass">
          <h2>Почнімо з однієї звички</h2>
          <p>Для кожної задай повну мету і мінімум — на дні, коли зовсім немає сил.</p>
          <div class="chips">${TEMPLATES.map((tp, i) => `<button class="chip glass press" data-act="template" data-i="${i}">${esc(tp[0])}</button>`).join('')}</div>
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
      <div class="txt"><b data-headline>${sum.total ? sum.head : 'Ще немає звичок'}</b><span data-sub>${sum.total ? sum.sub : 'Додай першу — і відмічай щодня.'}</span></div>
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
    row.classList.remove('v0', 'v1', 'v2');
    row.classList.add('v' + v);
    row.querySelector('.sub').innerHTML = habitSub(h, v);
    row.querySelector('.streak span').textContent = streakOf(h);
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
  let best = { n: 0, name: '' };
  S.habits.forEach((h) => { const n = longestOf(h); if (n > best.n) best = { n, name: h.name }; });
  let saved = 0;
  days.forEach((d) => activeOn(d).forEach((h) => { if (val(h.id, d) === 1) saved++; }));

  const bars = days.map((d, i) => {
    const hs = activeOn(d);
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
    const dots = last7.map((d) => `<i class="${d < h.start ? 'na' : 'v' + val(h.id, d)}"></i>`).join('');
    return `<div class="hrow"><span class="n">${esc(h.name)}</span><span class="dots">${dots}</span><span class="p">${eligible ? Math.round(any / eligible * 100) : 0}%</span></div>`;
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
          <div class="mini-card"><b>${best.n} ${plural(best.n, 'день', 'дні', 'днів')}</b><span>${best.n ? 'рекорд: ' + esc(best.name) : 'найдовший ланцюжок'}</span></div>
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

function openHabitSheet(h = null, preset = null) {
  const v = h || { name: preset?.[0] || '', full: preset?.[1] || '', min: preset?.[2] || '' };
  openSheet(`
    <h2>${h ? 'Редагувати звичку' : 'Нова звичка'}</h2>
    <div class="field"><label for="f-name">Назва</label><input id="f-name" maxlength="40" placeholder="Напр. Читання" value="${esc(v.name)}" autocomplete="off"></div>
    <div class="field"><label for="f-full">Повна мета</label><input id="f-full" maxlength="40" placeholder="Напр. 20 сторінок" value="${esc(v.full)}" autocomplete="off"></div>
    <div class="field"><label for="f-min">Мінімум на поганий день</label><input id="f-min" maxlength="40" placeholder="Напр. 1 сторінка" value="${esc(v.min)}" autocomplete="off"><small>Настільки мало, щоб це можна було зробити за будь-якого настрою.</small></div>
    <button class="btn primary block press" data-save>${h ? 'Зберегти' : 'Додати'}</button>
    ${h ? '<button class="btn danger block press" data-del>Видалити звичку</button>' : ''}
  `, (sheet) => {
    const name = sheet.querySelector('#f-name');
    if (!h) setTimeout(() => name.focus(), 350);
    sheet.querySelector('[data-save]').addEventListener('click', async () => {
      const n = name.value.trim();
      if (!n) { name.focus(); name.style.borderColor = '#FF8A80'; return; }
      await saveHabit({ id: h?.id, name: n, full: sheet.querySelector('#f-full').value.trim(), min: sheet.querySelector('#f-min').value.trim() });
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
function rerenderAnimated() {
  const el = currentView();
  if (!el) return;
  el.classList.remove('enter');
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
      <div class="set-row"><div class="l"><b>Нагадування</b><span>${needInstall ? 'Спершу встанови застосунок на початковий екран' : 'Якщо до цього часу не все відмічено'}</span></div>
        <button class="switch" role="switch" aria-checked="${ns.enabled}" aria-label="Нагадування" data-notify></button></div>
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
        if (on) { await disableNotifications(); sw.setAttribute('aria-checked', 'false'); toast('Нагадування вимкнено'); }
        else { await enableNotifications(time.value || '20:00'); sw.setAttribute('aria-checked', 'true'); toast('Нагадаю о ' + (time.value || '20:00')); }
      } catch (e) { toast(e.message || 'Не вдалося'); }
    });
    time.addEventListener('change', async () => {
      try { const s = await updateTime(time.value); if (s.enabled) toast('Нагадаю о ' + time.value); } catch (e) { toast(e.message); }
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
    const before = dayCounted(S.selDate);
    const v = nextVal(val(id, S.selDate));
    ripple(t, e);
    popEl(t.querySelector('.check'));
    await setMark(id, S.selDate, v);
    updateTodayDynamic(t);
    if (!before && dayCounted(S.selDate)) {
      confetti(currentView().querySelector('.ring'));
      toast(S.selDate === S.today ? 'День зараховано — ланцюжок росте' : 'День зараховано');
    }
  } else if (act === 'day') {
    S.selDate = t.dataset.date;
    rerenderAnimated();
  } else if (act === 'add') {
    openHabitSheet();
  } else if (act === 'template') {
    const tp = TEMPLATES[+t.dataset.i];
    await saveHabit({ name: tp[0], full: tp[1], min: tp[2] });
    toast('Додано: ' + tp[0]);
    rerenderAnimated();
  } else if (act === 'settings') {
    openSettings();
  } else if (act === 'cell') {
    const { id, date } = t.dataset;
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
  showTab(b.dataset.tab);
}));
window.addEventListener('resize', () => { moveIndicator(); if (S.tab === 'stats') placeKnob(currentView()); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (S.tab === 'today') rerender(); });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const now = todayKey();
  if (now !== S.today) {
    if (S.selDate === S.today) S.selDate = now;
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
    });
  }
  requestPersistence();
  await loadState();
  const want = new URLSearchParams(location.search).get('tab');
  showTab(TABS.includes(want) ? want : 'today');
  initSync(onServerMerge);
}
start();
