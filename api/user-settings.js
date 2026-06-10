// /api/user-settings — auto-save endpoint for all user preferences.
// GET   -> current settings (creates defaults on first call)
// PATCH -> merge partial updates (called debounced by web + app, no save buttons)
import { supabase } from './supabaseClient.js';
import { getJsonBody, requireUser } from './auth.js';
import { applyCors } from './cors.js';

const DEFAULTS = {
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  theme: 'dark',
  hotkey: 'Alt+C',
  api_priority: [],
  per_prompt_cap: 0,
  monthly_cap: 0,
  extra: {},
};

const ALLOWED = new Set(Object.keys(DEFAULTS));

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') {
    const body = getJsonBody(req);
    const patch = {};
    for (const [k, v] of Object.entries(body)) {
      if (!ALLOWED.has(k)) continue;
      if (k === 'api_priority' && !Array.isArray(v)) continue;
      if ((k === 'per_prompt_cap' || k === 'monthly_cap') && (!Number.isFinite(+v) || +v < 0)) continue;
      patch[k] = (k === 'per_prompt_cap' || k === 'monthly_cap') ? Math.floor(+v) : v;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ message: 'Nothing to save.' });
    }
    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: user.id, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) return res.status(500).json({ message: 'Could not save settings.' });
  } else if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  const { data } = await supabase
    .from('user_settings')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  return res.status(200).json({ settings: { ...DEFAULTS, ...(data || {}) } });
}
