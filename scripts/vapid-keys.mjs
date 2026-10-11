// Генерує VAPID-ключі для push-сповіщень без жодних пакетів.
// Запуск: node scripts/vapid-keys.mjs
import { createECDH, randomBytes } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('VAPID_PUBLIC_KEY=' + b64url(ecdh.getPublicKey()));
console.log('VAPID_PRIVATE_KEY=' + b64url(ecdh.getPrivateKey()));
console.log('CRON_SECRET=' + b64url(randomBytes(24)));
