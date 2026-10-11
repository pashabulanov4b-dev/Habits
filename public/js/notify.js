// Push-сповіщення (Web Push). На iPhone працюють лише коли застосунок
// встановлено на початковий екран (iOS 16.4+), і дозвіл треба просити після натискання кнопки.
import { db } from './db.js';
import { getUserId } from './sync.js';

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function b64ToBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function getNotifySettings() {
  return db.getMeta('notify', { enabled: false, time: '20:00' });
}

async function send(body) {
  const res = await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Сервер не відповів (' + res.status + ')');
}

export async function enableNotifications(time) {
  if (!pushSupported()) {
    throw new Error(isIOS() && !isStandalone()
      ? 'Спершу встанови застосунок на початковий екран, потім увімкни сповіщення.'
      : 'Цей браузер не підтримує сповіщення.');
  }
  if (!navigator.onLine) throw new Error('Потрібен інтернет, щоб увімкнути сповіщення.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Сповіщення заборонені. Дозволь їх у Параметрах iPhone → Сповіщення.');

  const cfg = await fetch('/api/config').then((r) => r.json());
  if (!cfg.vapidPublicKey) throw new Error('На сервері не налаштовано VAPID-ключі.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
  }
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await send({ userId: await getUserId(), subscription: sub.toJSON(), time, tz, enabled: true });
  const settings = { enabled: true, time };
  await db.setMeta('notify', settings);
  return settings;
}

export async function updateTime(time) {
  const s = await getNotifySettings();
  if (s.enabled) return enableNotifications(time);
  const settings = { ...s, time };
  await db.setMeta('notify', settings);
  return settings;
}

export async function disableNotifications() {
  const s = await getNotifySettings();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await send({ userId: await getUserId(), subscription: sub.toJSON(), enabled: false });
      await sub.unsubscribe();
    }
  } catch (e) { /* якщо офлайн — просто вимикаємо локально */ }
  const settings = { ...s, enabled: false };
  await db.setMeta('notify', settings);
  return settings;
}
