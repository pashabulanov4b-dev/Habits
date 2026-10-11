import { Redis } from '@upstash/redis';

// Vercel Marketplace (Upstash) додає KV_REST_API_*; при ручному підключенні — UPSTASH_REDIS_REST_*.
const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = url && token ? new Redis({ url, token }) : null;

export const keys = {
  habits: (uid) => `u:${uid}:h`,
  marks: (uid) => `u:${uid}:m`,
  push: (uid) => `u:${uid}:push`,
  pushUsers: 'push:users'
};

export function noDb(res) {
  res.status(500).json({ error: 'Сховище не підключене: додай Upstash Redis у Vercel → Storage.' });
}
