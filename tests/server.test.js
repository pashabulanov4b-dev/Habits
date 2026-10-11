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
