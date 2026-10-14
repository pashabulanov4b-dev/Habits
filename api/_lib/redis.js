import { Redis } from '@upstash/redis';

// Vercel Marketplace (Upstash) додає KV_REST_API_*; при ручному підключенні — UPSTASH_REDIS_REST_*.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = url && token ? new Redis({ url, token }) : null;

// Усі ключі з префіксом habits:, щоб базу можна було ділити з іншими проєктами без конфліктів.
const P = 'habits:';
export const keys = {
  habits: (uid) => `${P}u:${uid}:h`,
  marks: (uid) => `${P}u:${uid}:m`,
  tasks: (uid) => `${P}u:${uid}:t`,
  journal: (uid) => `${P}u:${uid}:j`,
  push: (uid) => `${P}u:${uid}:push`,
  pushUsers: `${P}push:users`
};

export function noDb(res) {
  res.status(500).json({ error: 'Сховище не підключене: додай Upstash Redis у Vercel → Storage.' });
}
