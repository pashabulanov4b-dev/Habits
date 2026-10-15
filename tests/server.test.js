import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecords, changedSince, cleanMark, cleanHabit, cleanTask, cleanJournal } from '../api/_lib/merge.js';
import { isDue, buildMessage, localParts, dueTasks, taskMessage } from '../api/_lib/reminder.js';

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

test('завдання: очищення та синхронізація полів', () => {
  const t = cleanTask({ id: 't-abc123', title: 'Купити квитки', date: '2026-10-12', time: '09:30', remind: true, done: false, order: 1, updatedAt: 5 });
  assert.deepEqual([t.title, t.date, t.time, t.remind, t.done], ['Купити квитки', '2026-10-12', '09:30', true, false]);
  assert.equal(cleanTask({ id: 'h-abcd', date: '2026-10-12' }), null);
  assert.equal(cleanTask({ id: 't-abcd', date: 'завтра' }), null);
  assert.equal(cleanTask({ id: 't-abcd', date: '2026-10-12', time: '25:00', remind: true }).remind, false);
});

test('нагадування про завдання: за 15 хв, один раз, тільки з дзвіночком', () => {
  const tasks = {
    a: { id: 't-aaaa', title: 'Лікар', date: '2026-10-12', time: '09:30', remind: true },
    b: { id: 't-bbbb', title: 'Без дзвіночка', date: '2026-10-12', time: '09:30', remind: false },
    c: { id: 't-cccc', title: 'Зроблено', date: '2026-10-12', time: '09:30', remind: true, done: true },
    d: { id: 't-dddd', title: 'Завтра', date: '2026-10-13', time: '09:30', remind: true }
  };
  const at = (h, m) => ({ date: '2026-10-12', minutes: h * 60 + m });
  assert.deepEqual(dueTasks(tasks, at(9, 0)), []);
  assert.deepEqual(dueTasks(tasks, at(9, 15)).map((t) => t.id), ['t-aaaa']);
  assert.deepEqual(dueTasks(tasks, at(9, 20), { 't-aaaa': '2026-10-12 09:15' }), []);
  // змінили час — нагадає ще раз
  assert.equal(dueTasks({ a: { ...tasks.a, time: '10:00' } }, at(9, 45), { 't-aaaa': '2026-10-12 09:15' }).length, 1);
  assert.deepEqual([taskMessage(tasks.a).title, taskMessage(tasks.a).body], ['Лікар', 'Сьогодні о 09:30']);
  assert.equal(isDue({ enabled: true, daily: false, subs: [{}], time: '20:00', tz: 'UTC' }, Date.UTC(2026, 9, 12, 20, 5)).due, false);
});

test('проміжок часу і свій час нагадування', () => {
  const t = cleanTask({ id: 't-range1', title: 'Робота', date: '2026-10-12', time: '14:20', endTime: '18:00', remind: true, remindAt: '13:20' });
  assert.deepEqual([t.time, t.endTime, t.remindAt, t.remind], ['14:20', '18:00', '13:20', true]);
  // кінець раніше за початок — відкидаємо
  assert.equal(cleanTask({ id: 't-range2', date: '2026-10-12', time: '14:20', endTime: '10:00' }).endTime, '');
  // нагадування без часу завдання — можна
  const n = cleanTask({ id: 't-notime', title: 'Подзвонити', date: '2026-10-12', remind: true, remindAt: '11:00' });
  assert.deepEqual([n.time, n.remind, n.remindAt], ['', true, '11:00']);
  // стара версія застосунку: remind без remindAt → за 15 хв
  assert.equal(cleanTask({ id: 't-old111', date: '2026-10-12', time: '09:30', remind: true }).remindAt, '09:15');
  const at = (h, m) => ({ date: '2026-10-12', minutes: h * 60 + m });
  assert.equal(dueTasks({ n }, at(11, 2)).length, 1);
  assert.equal(dueTasks({ t }, at(13, 20)).length, 1);
  assert.equal(dueTasks({ t }, at(13, 0)).length, 0);
  assert.equal(taskMessage(t).body, 'Сьогодні о 14:20–18:00');
});

test('нотатки: до звички і до дня', () => {
  const h = cleanHabit({ id: 'h-note1', name: 'Спорт', note: 'Для спини', askNote: true });
  assert.deepEqual([h.note, h.askNote], ['Для спини', true]);
  assert.equal(cleanHabit({ id: 'h-note2', name: 'x' }).askNote, false);
  assert.equal(cleanMark({ habitId: 'h-note1', date: '2026-10-12', value: 2, note: 'Біг 5 км' }).note, 'Біг 5 км');
  assert.equal(cleanMark({ habitId: 'h-note1', date: '2026-10-12', value: 2, note: 'x'.repeat(900) }).note.length, 500);
  assert.equal(cleanMark({ habitId: 'h-note1', date: '2026-10-12', value: 2, note: 42 }).note, '');
});

test('нотатки до завдань', () => {
  const t = cleanTask({ id: 't-note1', title: 'Лікар', date: '2026-10-12', note: 'Взяти паспорт', askNote: true, doneNote: 'Все добре' });
  assert.deepEqual([t.note, t.askNote, t.doneNote], ['Взяти паспорт', true, 'Все добре']);
  const e = cleanTask({ id: 't-note2', title: 'x', date: '2026-10-12' });
  assert.deepEqual([e.note, e.askNote, e.doneNote], ['', false, '']);
});

test('щоденник: власні записи і позначка «в щоденнику»', () => {
  const j = cleanJournal({ id: 'j-abc123', date: '2026-10-15', text: 'Гарний день', createdAt: 1, updatedAt: 2 });
  assert.deepEqual([j.date, j.text, j.deleted], ['2026-10-15', 'Гарний день', false]);
  assert.equal(cleanJournal({ id: 't-abc123', date: '2026-10-15' }), null);
  assert.equal(cleanJournal({ id: 'j-abc123', date: 'вчора' }), null);
  assert.equal(cleanMark({ habitId: 'h-note1', date: '2026-10-12', value: 2, note: 'x', jAt: 77 }).jAt, 77);
  assert.equal(cleanMark({ habitId: 'h-note1', date: '2026-10-12', value: 2 }).jAt, 0);
  assert.equal(cleanTask({ id: 't-note1', date: '2026-10-12', doneNote: 'ok', jAt: 5 }).jAt, 5);
  assert.equal(cleanTask({ id: 't-imp1', date: '2026-10-12', important: 1 }).important, true);
  assert.equal(cleanTask({ id: 't-imp2', date: '2026-10-12' }).important, false);
});

import { stagesOf, stageOn, planOn, dueSleep, sleepMinutes } from '../public/js/sleepcore.js';
import { cleanSleep } from '../api/_lib/merge.js';

test('режим сну: етапи за замовчуванням і перерахунок', () => {
  const st = stagesOf({});
  assert.deepEqual(st.map((s) => [s.wake, s.bed, s.creative]), [
    ['10:30', '02:30', '01:45'], ['09:45', '02:00', '01:15'], ['09:00', '01:15', '00:30'], ['08:00', '00:30', '23:45']]);
  // інші вхідні часи → рівномірно: 01:00/09:00 → 23:00/07:00
  const u = stagesOf({ curBed: '01:00', curWake: '09:00', tgtBed: '23:00', tgtWake: '07:00' });
  assert.deepEqual(u.map((s) => [s.wake, s.bed]), [['08:30', '00:30'], ['08:00', '00:00'], ['07:30', '23:30'], ['07:00', '23:00']]);
});

test('режим сну: тижні, повтор тижня, рання зміна', () => {
  const cfg = { active: true, start: '2026-10-12', repeats: 0 };
  assert.equal(stageOn(cfg, '2026-10-11'), null);
  assert.deepEqual(stageOn(cfg, '2026-10-18'), { week: 0, idx: 0 });
  assert.deepEqual(stageOn(cfg, '2026-10-19'), { week: 1, idx: 1 });
  assert.equal(stageOn({ ...cfg, repeats: 1 }, '2026-10-19').idx, 0);
  assert.equal(stageOn(cfg, '2026-12-30').idx, 3);
  const p = planOn(cfg, { '2026-10-13': { shift: '06:00' } }, '2026-10-13');
  assert.deepEqual([p.wake, p.planWake, p.bed], ['06:00', '10:30', '02:30']);
});

test('режим сну: сповіщення вчасно, один раз, вимикаються окремо', () => {
  const cfg = { active: true, start: '2026-10-12', notif: { coffee: false } };
  const at = (h, m) => ({ date: '2026-10-13', minutes: h * 60 + m });
  assert.deepEqual(dueSleep(cfg, {}, at(10, 33)).map((n) => n.key), ['wake']);
  assert.deepEqual(dueSleep(cfg, {}, at(10, 36), { wake: Date.now() }).map((n) => n.key), ['light']);
  assert.deepEqual(dueSleep(cfg, {}, at(14, 50)), []); // кава вимкнена
  assert.deepEqual(dueSleep(cfg, {}, at(0, 35)).map((n) => n.key), ['dim']); // відбій 02:30 → 00:30
  assert.deepEqual(dueSleep(cfg, {}, at(2, 16)).map((n) => n.key), ['bed']);
  assert.equal(sleepMinutes('02:30', '10:30'), 480);
  assert.equal(sleepMinutes('23:30', '07:00'), 450);
});

test('режим сну: очищення записів', () => {
  const c = cleanSleep({ id: 's-cfg', active: true, start: '2026-10-12', curBed: '03:00', notif: { coffee: false }, repeats: 2 });
  assert.deepEqual([c.active, c.curBed, c.notif.coffee, c.notif.wake, c.repeats], [true, '03:00', false, true, 2]);
  assert.equal(cleanSleep({ id: 's-d-2026-10-13', wake: '10:41', bed: '25:00' }).bed, '');
  assert.equal(cleanSleep({ id: 's-x' }), null);
  assert.equal(cleanSleep({ id: 's-i-abcd12', text: 'ідея', date: '2026-10-13' }).text, 'ідея');
});
