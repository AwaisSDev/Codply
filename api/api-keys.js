// /api/api-keys — encrypted server-side API key storage.
// Keys are AES-256-GCM encrypted with API_KEY_ENCRYPTION_SECRET and NEVER
// shipped in any client bundle. The desktop app fetches the signed-in owner's
// own keys (?reveal=1) over HTTPS with a Bearer token to enable failover.
// GET            -> [{ provider, hint, updated_at }]
// GET ?reveal=1  -> [{ provider, key }]  (owner only, for the desktop app)
// POST           -> { provider, api_key } upsert
// DELETE         -> { provider } remove
import crypto from 'node:crypto';
import { supabase } from './supabaseClient.js';
import { getJsonBody, requireUser } from './auth.js';
import { applyCors } from './cors.js';

const allowedProviders = new Set(['openai', 'claude', 'openrouter', 'groq', 'gemini', 'deepseek', 'qwen', 'custom']);

function getKey() {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('API_KEY_ENCRYPTION_SECRET must be at least 32 characters.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function hint(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length <= 8) return 'Saved';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const reveal = url.searchParams.get('reveal') === '1';
    const { data, error } = await supabase
      .from('user_api_keys')
      .select('provider,encrypted_key,key_hint,updated_at')
      .eq('user_id', user.id);
    if (error) return res.status(500).json({ message: 'Could not load keys.' });

    if (reveal) {
      // Owner-only: decrypt for the authenticated user's own desktop app.
      const keys = [];
      for (const row of data || []) {
        try { keys.push({ provider: row.provider, key: decrypt(row.encrypted_key) }); }
        catch { /* skip undecryptable rows */ }
      }
      return res.status(200).json({ keys });
    }
    return res.status(200).json({
      keys: (data || []).map((k) => ({ provider: k.provider, hint: k.key_hint || 'Saved', updated_at: k.updated_at })),
    });
  }

  const body = getJsonBody(req);
  const provider = String(body.provider || '').trim().toLowerCase();
  if (!allowedProviders.has(provider)) {
    return res.status(400).json({ message: 'Choose a valid provider.' });
  }

  if (req.method === 'DELETE') {
    const { error } = await supabase
      .from('user_api_keys')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', provider);
    if (error) return res.status(500).json({ message: 'Could not delete key.' });
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  const apiKey = String(body.api_key || '').trim();
  if (apiKey.length < 6) {
    return res.status(400).json({ message: 'Enter a valid API key.' });
  }

  const { error } = await supabase
    .from('user_api_keys')
    .upsert({
      user_id: user.id,
      provider,
      encrypted_key: encrypt(apiKey),
      key_hint: hint(apiKey),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider' });

  if (error) return res.status(500).json({ message: 'Could not save key.' });
  return res.status(200).json({ ok: true, provider, hint: hint(apiKey) });
}
