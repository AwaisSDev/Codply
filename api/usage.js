// /api/usage — cumulative token usage per user (monthly), plus cap status.
// GET  -> { month, tokens, requests, monthly_cap, per_prompt_cap, capReached }
// POST -> { tokens, requests? } adds usage for the current month
import { supabase } from './supabaseClient.js';
import { getJsonBody, requireUser } from './auth.js';
import { applyCors } from './cors.js';

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const user = await requireUser(req, res);
  if (!user) return;

  const month = currentMonth();

  if (req.method === 'POST') {
    const body = getJsonBody(req);
    const tokens = Math.max(0, Math.floor(+body.tokens || 0));
    const requests = Math.max(0, Math.floor(+body.requests || 1));
    if (tokens > 0 || requests > 0) {
      const { data: row } = await supabase
        .from('usage_monthly')
        .select('tokens,requests')
        .eq('user_id', user.id)
        .eq('month', month)
        .maybeSingle();
      const { error } = await supabase.from('usage_monthly').upsert({
        user_id: user.id,
        month,
        tokens: (row?.tokens || 0) + tokens,
        requests: (row?.requests || 0) + requests,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,month' });
      if (error) return res.status(500).json({ message: 'Could not record usage.' });
    }
  } else if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  const [{ data: usage }, { data: settings }] = await Promise.all([
    supabase.from('usage_monthly').select('tokens,requests').eq('user_id', user.id).eq('month', month).maybeSingle(),
    supabase.from('user_settings').select('monthly_cap,per_prompt_cap').eq('user_id', user.id).maybeSingle(),
  ]);

  const tokens = usage?.tokens || 0;
  const monthlyCap = settings?.monthly_cap || 0;

  return res.status(200).json({
    month,
    tokens,
    requests: usage?.requests || 0,
    monthly_cap: monthlyCap,
    per_prompt_cap: settings?.per_prompt_cap || 0,
    capReached: monthlyCap > 0 && tokens >= monthlyCap,
  });
}
