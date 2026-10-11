export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
}
