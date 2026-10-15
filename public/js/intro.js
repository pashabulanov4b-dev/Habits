// «Звички» · вітальні сторінки при першому відкритті (і після великого оновлення) — як у FinTrack / Telegram.
// Гортаються пальцем (scroll-snap) або кнопкою «Далі»; анімації мініатюр стартують, коли сторінка на екрані.
// Показується один раз на кожну версію INTRO_VERSION. Відкрити ще раз: Налаштування → «Що вміє застосунок».

const INTRO_VERSION = '2';
const KEY = 'introSeen';

const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const FLAME = '<svg viewBox="0 0 24 24"><path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
const SUN = '<svg viewBox="0 0 24 24"><path d="M12 3v5M5.6 8.6l1.4 1.4M18.4 8.6L17 10M3 16h2M19 16h2M8 16a4 4 0 0 1 8 0M3 20h18"/></svg>';
const BELL = '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
const REP = '<svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>';
const FILE = '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3"/></svg>';

const SLIDES = [
  { t: 'Звички, план і щоденник', d: 'Усе для твого дня в одному місці. Працює без інтернету, а коли він зʼявляється — синхронізується з іншими пристроями.', art: `
    <div class="in-hero">
      <div class="in-orb a"></div><div class="in-orb b"></div><div class="in-orb c"></div>
      <div class="in-icon">${CHECK}</div>
      <div class="in-ring"><svg viewBox="0 0 120 120"><circle class="t" cx="60" cy="60" r="52"/><circle class="v" cx="60" cy="60" r="52" pathLength="100"/></svg><b>86%</b></div>
      <b class="in-spark s1"></b><b class="in-spark s2"></b><b class="in-spark s3"></b>
    </div>` },
  { t: 'Відмічай одним дотиком', d: 'Тап — і звичка зарахована. Якщо звичка з кількістю, вводиш скільки зробив: 19 з 20 сторінок теж рахується. Вогник — твій ланцюжок днів.', art: `
    <div class="in-list">
      <div class="in-hab h1"><span class="n"><b>Спорт</b><small>3 рази на тиждень · 2/3</small></span><i class="fl">${FLAME}5</i><i class="ck">${CHECK}</i></div>
      <div class="in-hab h2"><span class="n"><b>Читання</b><small><em class="cnt"><i>0</i><i>12</i><i>19</i></em> / 20 стор.</small></span><i class="fl">${FLAME}12</i><i class="ck num">19</i><i class="bar"></i></div>
      <div class="in-hab h3"><span class="n"><b>Німецька</b><small>Мета: 20 слів</small></span><i class="fl">${FLAME}8</i><i class="ck">${CHECK}</i></div>
      <i class="in-tap"></i>
    </div>` },
  { t: 'План на будь-який день', d: 'Справи з часом «14:20–18:00», нагадування, повтори щотижня. Важливі дні — Appointment, іспит — світяться червоною крапкою.', art: `
    <div class="in-plan">
      <div class="in-strip">${[['Пт', 16, 'open'], ['Сб', 17, 'imp'], ['Нд', 18, ''], ['Пн', 19, 'open'], ['Вт', 20, 'imp'], ['Ср', 21, 'open']].map(([w, n, c], i) => `<span class="${i === 0 ? 'sel' : ''}" style="--d:${i * 60}ms"><small>${w}</small><b>${n}</b><i class="${c}"></i></span>`).join('')}</div>
      <div class="in-task t1"><i class="bx"></i><span><b><em class="imp"></em>Термін у Jobcenter</b><small>${BELL}Нагадаю о 08:30</small></span><em class="tm">09:30</em></div>
      <div class="in-task t2"><i class="bx"></i><span><b>Kaffeesack</b><small>Зараз · до 18:00</small></span><em class="tm rng">14:20–18:00</em></div>
      <div class="in-task t3"><i class="bx on">${CHECK}</i><span><b>Спортзал <em class="rp">${REP}</em></b><small>пн, ср, пт</small></span><em class="tm">18:00</em></div>
    </div>` },
  { t: 'Щоденник', d: 'Пиши про свій день. А нотатки «Як пройшло?» після звичок і справ потрапляють сюди одним перемикачем.', art: `
    <div class="in-jr">
      <div class="in-sheet"><b>Як пройшло?</b><span class="in-typed"><span>Біг 5 км, легко</span></span><div class="in-sw"><small>Додати в щоденник</small><i></i></div></div>
      <div class="in-jc j1"><span class="pill me">Мій запис</span><p>Продуктивний день, нарешті розібрався з документами.</p></div>
      <div class="in-jc j2"><span class="pill hb">${CHECK}Спорт</span><p>Біг 5 км, легко</p></div>
    </div>` },
  { t: 'Режим сну', d: 'Чотири тижні, щоб засинати й вставати раніше. Щотижня підйом трохи раніше, нагадування про світло, каву й відбій.', art: `
    <div class="in-sleep">
      <div class="in-moon">${MOON}</div>
      <div class="in-times"><span>${SUN}<small>Підйом</small><b class="roll"><i>11:00</i><i>10:30</i><i>09:45</i><i>08:00</i></b></span><span>${MOON}<small>Відбій</small><b class="roll"><i>03:00</i><i>02:30</i><i>02:00</i><i>00:30</i></b></span></div>
      <div class="in-steps">${[1, 2, 3, 4].map((n, i) => `<i style="--d:${0.4 + i * 0.45}s">Етап ${n}</i>`).join('')}</div>
    </div>` },
  { t: 'Бачиш свій прогрес', d: 'Таблиця місяця, відсоток кожного дня й найдовші ланцюжки — видно, як звички стають звичкою.', art: `
    <div class="in-stats">
      <div class="in-grid">${Array.from({ length: 28 }, (_, i) => { const v = [2, 2, 1, 2, 0, 2, 2, 2, 2, 1, 2, 2, 0, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2][i]; return `<i class="v${v}" style="--d:${i * 28}ms"></i>`; }).join('')}</div>
      <div class="in-bars">${[40, 62, 55, 80, 72, 90, 100].map((h, i) => `<i style="--h:${h}%;--d:${0.9 + i * 0.07}s"></i>`).join('')}</div>
      <div class="in-kpi"><span><b>92%</b><small>за тиждень</small></span><span><b>${FLAME}12</b><small>днів поспіль</small></span></div>
    </div>` },
  { t: 'Нагадування й копія', d: 'Увімкни нагадування в ⚙️ Налаштуваннях. А раз на тиждень-два зберігай резервну копію — так дані точно не загубляться.', art: `
    <div class="in-last">
      <div class="in-push"><i>${BELL}</i><span><b>Відбій через 15 хв</b><small>Лягай о 02:00.</small></span></div>
      <div class="in-push p2"><i class="lime">${CHECK}</i><span><b>Залишилось: 1 звичка</b><small>Читання — ще встигаєш.</small></span></div>
      <div class="in-file">${FILE}<span>zvychky-копія.json</span></div>
    </div>` }
];

let el = null, idx = 0;
const $ = (s) => el.querySelector(s);

function build() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Що вміє застосунок');
  el.innerHTML = `<div class="in-box">
      <button type="button" class="in-skip">Пропустити</button>
      <div class="in-pages">${SLIDES.map((s, i) => `
        <section class="in-page" aria-roledescription="сторінка" aria-label="${i + 1} з ${SLIDES.length}">
          <div class="in-art" aria-hidden="true">${s.art}</div>
          <h2>${s.t}</h2><p>${s.d}</p>
        </section>`).join('')}</div>
      <div class="in-foot">
        <div class="in-dots" role="tablist">${SLIDES.map((s, i) => `<button type="button" role="tab" aria-label="Сторінка ${i + 1}" data-go="${i}"></button>`).join('')}</div>
        <button type="button" class="in-next">Далі</button>
      </div></div>`;
  document.body.appendChild(el);
  const pages = $('.in-pages');
  let raf = 0;
  pages.addEventListener('scroll', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sync); }, { passive: true });
  $('.in-skip').addEventListener('click', closeIntro);
  $('.in-next').addEventListener('click', () => (idx >= SLIDES.length - 1 ? closeIntro() : go(idx + 1)));
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.go))));
  document.addEventListener('keydown', (e) => {
    if (!el.classList.contains('open')) return;
    if (e.key === 'ArrowRight') $('.in-next').click(); else if (e.key === 'ArrowLeft') go(idx - 1); else if (e.key === 'Escape') closeIntro();
  });
  return el;
}
function sync() {
  const pages = $('.in-pages');
  const i = Math.max(0, Math.min(SLIDES.length - 1, Math.round(pages.scrollLeft / Math.max(1, pages.clientWidth))));
  if (i === idx && el.querySelector('.in-page.on')) return;
  idx = i;
  el.querySelectorAll('.in-page').forEach((p, k) => p.classList.toggle('on', k === i));
  el.querySelectorAll('.in-dots button').forEach((d, k) => { d.classList.toggle('on', k === i); d.setAttribute('aria-selected', k === i); });
  const last = i === SLIDES.length - 1;
  $('.in-next').textContent = last ? 'Почати' : 'Далі';
  $('.in-skip').style.visibility = last ? 'hidden' : '';
}
function go(i) {
  const pages = $('.in-pages');
  i = Math.max(0, Math.min(SLIDES.length - 1, i));
  pages.scrollTo({ left: i * pages.clientWidth, behavior: 'smooth' });
}
export function openIntro() {
  build();
  idx = -1;
  $('.in-pages').scrollLeft = 0;
  el.classList.remove('closing');
  el.classList.add('open');
  requestAnimationFrame(sync);
}
export function closeIntro() {
  if (!el || !el.classList.contains('open')) return;
  el.classList.add('closing');
  setTimeout(() => { el.classList.remove('open', 'closing'); el.querySelectorAll('.in-page').forEach((p) => p.classList.remove('on')); }, 320);
  try { localStorage.setItem(KEY, INTRO_VERSION); } catch (e) { /* ок */ }
}
export function maybeShowIntro() {
  let seen = false;
  try { seen = localStorage.getItem(KEY) === INTRO_VERSION; } catch (e) { seen = true; }
  if (!seen) setTimeout(openIntro, 450);
}
