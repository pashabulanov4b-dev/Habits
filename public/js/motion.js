// Анімації на anime.js (v3.2.2, лежить локально — працює й без інтернету).
// Усі ефекти короткі й «пружинні», реагують на дотик. Якщо в системі ввімкнено
// «Зменшити рух», нічого не анімуємо — просто ставимо кінцевий стан.
import anime from './vendor/anime.es.js';

const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPRING = 'spring(1, 170, 14, 0)';      // відмітки, кнопки
const SOFT = 'spring(1, 110, 15, 0)';        // появи списків
const LIME = '#D4F57A';

/** Пружинний «поп» елемента (галочка, кнопка) */
export function pop(el, from = 0.72) {
  if (!el || reduce()) return;
  anime.remove(el);
  anime({ targets: el, scale: [from, 1], duration: 650, easing: SPRING });
}

/** Сплеск частинок з центру елемента — коли щось відмічено */
export function burst(el, { color = LIME, count = 10, radius = 34 } = {}) {
  if (!el || reduce()) return;
  const fx = document.getElementById('fx');
  if (!fx) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const dots = [];
  for (let i = 0; i < count; i++) {
    const d = document.createElement('i');
    d.className = 'mdot';
    d.style.left = cx + 'px'; d.style.top = cy + 'px';
    d.style.background = i % 3 === 2 ? '#F2F4F7' : color;
    fx.appendChild(d);
    dots.push(d);
  }
  const ring = document.createElement('i');
  ring.className = 'mring';
  ring.style.left = cx + 'px'; ring.style.top = cy + 'px'; ring.style.borderColor = color;
  fx.appendChild(ring);
  anime({ targets: ring, scale: [0.4, 2.1], opacity: [0.7, 0], duration: 560, easing: 'easeOutCubic', complete: () => ring.remove() });
  anime({
    targets: dots,
    translateX: (d, i) => Math.cos((i / count) * Math.PI * 2 + 0.3) * (radius + Math.random() * 14),
    translateY: (d, i) => Math.sin((i / count) * Math.PI * 2 + 0.3) * (radius + Math.random() * 14),
    scale: [{ value: 1.1, duration: 120 }, { value: 0, duration: 420 }],
    opacity: [{ value: 1, duration: 80 }, { value: 0, duration: 460, delay: 60 }],
    easing: 'easeOutExpo',
    duration: 620,
    delay: anime.stagger(12),
    complete: () => dots.forEach((d) => d.remove())
  });
}

/** Конфеті, коли день зараховано / усі справи зроблено */
export function confetti(fromEl) {
  if (reduce()) return;
  const fx = document.getElementById('fx');
  if (!fx) return;
  const r = fromEl ? fromEl.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 3, width: 0, height: 0 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const colors = [LIME, '#F2F4F7', '#B8B4FF', '#6FE3D3', '#E8FFB0'];
  const parts = [];
  for (let i = 0; i < 42; i++) {
    const s = document.createElement('i');
    s.className = 'spark';
    s.style.left = cx + 'px'; s.style.top = cy + 'px';
    s.style.background = colors[i % colors.length];
    if (i % 3 === 0) s.style.borderRadius = '50%';
    fx.appendChild(s);
    parts.push(s);
  }
  anime({
    targets: parts,
    // злітають віялом угору, потім падають униз — як справжнє конфеті
    translateX: () => anime.random(-170, 170),
    translateY: [{ value: () => anime.random(-190, -70), duration: 520, easing: 'easeOutCubic' },
      { value: () => anime.random(140, 260), duration: 900, easing: 'easeInQuad' }],
    rotate: () => anime.random(-540, 540),
    scale: [{ value: [0, 1.15], duration: 220, easing: 'easeOutBack' }, { value: 0.5, duration: 1200 }],
    opacity: [{ value: 1, duration: 900 }, { value: 0, duration: 520 }],
    delay: anime.stagger(6),
    complete: () => parts.forEach((p) => p.remove())
  });
}

/** Плавний лічильник: 0% → 72% */
export function countTo(el, to, suffix = '') {
  if (!el) return;
  const from = parseInt(el.textContent, 10) || 0;
  if (reduce() || from === to) { el.textContent = to + suffix; return; }
  const o = { v: from };
  anime.remove(o);
  anime({ targets: o, v: to, round: 1, duration: 900, easing: 'easeOutExpo', update: () => { el.textContent = o.v + suffix; } });
}

/** Каскадна поява дочірніх елементів (вікна, списки) */
export function cascade(nodes, { y = 16, step = 28, start = 40 } = {}) {
  const list = [...nodes].filter(Boolean);
  if (!list.length || reduce()) return;
  anime({ targets: list, translateY: [y, 0], opacity: [0, 1], duration: 700, easing: SOFT,
    delay: anime.stagger(step, { start }), complete: () => list.forEach((n) => { n.style.transform = ''; n.style.opacity = ''; }) });
}

/** Стовпчики графіка ростуть знизу один за одним */
export function growBars(bars, { from = 'first' } = {}) {
  const list = [...bars];
  if (!list.length || reduce()) return;
  anime({ targets: list, scaleY: [0, 1], duration: 900, easing: 'spring(1, 90, 13, 0)', delay: anime.stagger(35, { from, start: 80 }) });
}

/** Смужки прогресу днів заповнюються після гортання тижня */
export function fillMinis(nodes) {
  const list = [...nodes];
  if (!list.length || reduce()) return;
  anime({ targets: list, scaleX: [0, 1], duration: 600, easing: 'easeOutExpo', delay: anime.stagger(30, { start: 60 }) });
}

/** Іконка вкладки «підстрибує» при натисканні */
export function tabBounce(icon) {
  if (!icon || reduce()) return;
  anime.remove(icon);
  anime({ targets: icon, keyframes: [{ scale: 0.78, rotate: -8, duration: 90 }, { scale: 1.14, rotate: 4, duration: 160 }, { scale: 1, rotate: 0, duration: 420 }], easing: 'easeOutQuad' });
}

/** Картка дня мʼяко світиться, коли день зараховано */
export function glow(el) {
  if (!el || reduce()) return;
  anime({ targets: el, keyframes: [{ scale: 1.025, duration: 180 }, { scale: 1, duration: 650 }], easing: 'easeOutElastic(1, .6)' });
  anime({ targets: el, boxShadow: ['0 0 0 0 rgba(212,245,122,.0)', '0 0 0 6px rgba(212,245,122,.18)', '0 0 0 0 rgba(212,245,122,0)'], duration: 1100, easing: 'easeOutQuad' });
}

/** Поточний етап у «Режимі сну» пульсує один раз */
export function pulse(el) {
  if (!el || reduce()) return;
  anime({ targets: el, scale: [1, 1.5, 1], duration: 1100, easing: 'easeInOutSine', delay: 350 });
}

/** Рядок справи «відʼїжджає» трохи вбік, коли виконано */
export function nudge(el) {
  if (!el || reduce()) return;
  anime.remove(el);
  anime({ targets: el, translateX: [0, 7, 0], duration: 520, easing: 'easeOutElastic(1, .5)' });
}
