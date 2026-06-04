import crypto from 'node:crypto';
import { supabase } from './supabaseClient.js';
import { getJsonBody, requireUser } from './auth.js';

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

function hint(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length <= 8) return 'Saved';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

async function isPro(userId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('plan,status')
    .eq('user_id', userId)
    .maybeSingle();
  return data?.plan === 'pro' && data?.status === 'active';
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (!(await isPro(user.id))) {
    return res.status(403).json({ message: 'API key storage is available on Pro.' });
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
    res.setHeader('Allow', 'POST, DELETE');
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