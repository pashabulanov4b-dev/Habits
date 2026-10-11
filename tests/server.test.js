import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecords, changedSince, cleanMark, cleanHabit } from '../api/_lib/merge.js';
import { isDue, buildMessage, localParts } from '../api/_lib/reminder.js';

const m = (habitId, date, value, updatedAt) => cleanMark({ habitId, date, value, updatedAt });

test('новіший запис перемагає, старіший ігнорується', () => {
  const existing = { 'h-abcd|2026-10-11': JSON.stringify({ ...m('h-abcd', '2026-10-11', 2, 200), sv: 1 }) };
  const w1 = mergeRecords(existing, [m('h-abcd', '2026-10-11', 1, 100)], (r) => r.k, 5);
  assert.deepEqual(w1, {});
  const w2 = mergeRecords(existing, [m('h-abcd', '2026-10-11', 1, 300)], (r) => r.k, 5);
  assert.equal(w2['h-abcd|2026-10-11'].value, 1);
  assert.equal(w2['h-abcd|2026-10-11'].sv, 5);
});

test('changedSince віддає тільки нові на сервері записи без поля sv', () => {
  const all = {
    a: JSON.stringify({ k: 'a', updatedAt: 1, sv: 10 }),
    b: { k: 'b', updatedAt: 1, sv: 50 } // Upstash може повертати вже розпарсений об'єкт
  };
  const out = changedSince(all, 20);
  assert.deepEqual(out, [{ k: 'b', updatedAt: 1 }]);
});

test('очищення відкидає сміття', () => {
  assert.equal(cleanMark({ habitId: '../x', date: '2026-10-11', value: 2 }), null);
  assert.equal(cleanMark({ habitId: 'h-abcd', date: '11.10', value: 2 }), null);
  assert.equal(cleanMark({ habitId: 'h-abcd', date: '2026-10-11', value: 9 }).value, 0);
  assert.equal(cleanHabit({ id: 'h-abcd', name: 'x'.repeat(200) }).name.length, 60);
});

test('кількість зберігається при синхронізації', () => {
  assert.equal(cleanMark({ habitId: 'h-abcd', date: '2026-10-11', value: 1, amount: 19 }).amount, 19);
  assert.equal(cleanMark({ habitId: 'h-abcd', date: '2026-10-11', value: 1, amount: -3 }).amount, null);
  assert.equal(cleanMark({ habitId: 'h-abcd', date: '2026-10-11', value: 2 }).amount, null);
  const h = cleanHabit({ id: 'h-abcd', name: 'Читання', kind: 'count', target: 20, minAmount: 1, unit: 'стор.' });
  assert.deepEqual([h.kind, h.target, h.minAmount, h.unit], ['count', 20, 1, 'стор.']);
  assert.equal(cleanHabit({ id: 'h-abcd', name: 'x', kind: 'evil' }).kind, 'check');
});

test('тижнева звичка: нагадування лише коли інакше не встигнути', () => {
  // 2026-10-11 — неділя. Спорт 3×/тиж, створено задовго до цього.
  const habits = { 'h-sport': { id: 'h-sport', name: 'Спорт', start: '2026-09-01', perWeek: 3 } };
  const mk = (...days) => Object.fromEntries(days.map((d) => ['h-sport|' + d, { value: 2 }]));
  // уже 3 рази цього тижня → не нагадуємо
  assert.equal(buildMessage(habits, mk('2026-10-05', '2026-10-07', '2026-10-09'), '2026-10-11'), null);
  // 2 рази, сьогодні останній день → треба сьогодні
  assert.match(buildMessage(habits, mk('2026-10-05', '2026-10-07'), '2026-10-11').body, /^Спорт/);
  // середа, ще жодного разу: треба 3, лишилось 5 днів → не нагадуємо
  assert.equal(buildMessage(habits, {}, '2026-10-07'), null);
  // п'ятниця, 0 разів: треба 3, лишилось 3 дні → нагадуємо
  assert.notEqual(buildMessage(habits, {}, '2026-10-09'), null);
  assert.equal(cleanHabit({ id: 'h-abcd', perWeek: 3 }).perWeek, 3);
  assert.equal(cleanHabit({ id: 'h-abcd', perWeek: 99 }).perWeek, 7);
});

test('часовий пояс рахується правильно', () => {
  const t = Date.UTC(2026, 9, 11, 18, 5); // 18:05 UTC = 20:05 у Берліні (літній час)
  assert.deepEqual(localParts(t, 'Europe/Berlin'), { date: '2026-10-11', minutes: 20 * 60 + 5 });
});

test('нагадування: вчасно, не двічі, не раніше', () => {
  const cfg = { enabled: true, subs: [{ endpoint: 'https://x' }], time: '20:00', tz: 'Europe/Berlin', lastSent: null };
  const at = (h, mi) => Date.UTC(2026, 9, 11, h - 2, mi);
  assert.equal(isDue(cfg, at(19, 50)).due, false);
  assert.equal(isDue(cfg, at(20, 7)).due, true);
  assert.equal(isDue({ ...cfg, lastSent: '2026-10-11' }, at(20, 7)).due, false);
  assert.equal(isDue(cfg, at(23, 30)).due, false);
});

test('текст нагадування: тільки невідмічені, нічого якщо все зроблено', () => {
  const habits = {
    'h-aaaa': { id: 'h-aaaa', name: 'Читання', start: '2026-10-01' },
    'h-bbbb': { id: 'h-bbbb', name: 'Спорт', start: '2026-10-01' },
    'h-cccc': { id: 'h-cccc', name: 'Старе', start: '2026-10-01', deleted: true }
  };
  const marks = { 'h-aaaa|2026-10-11': { value: 1 } };
  const msg = buildMessage(habits, marks, '2026-10-11');
  assert.equal(msg.title, 'Залишилось: 1 звичка');
  assert.match(msg.body, /^Спорт\./);
  const done = buildMessage(habits, { ...marks, 'h-bbbb|2026-10-11': { value: 2 } }, '2026-10-11');
  assert.equal(done, null);
});
