import { supabase } from './supabaseClient.js';
import { ensureProfile, getJsonBody, requireUser } from './auth.js';

const starterProviders = new Set(['openrouter', 'groq']);

const providerLabels = {
  openai: 'OpenAI / ChatGPT',
  claude: 'Claude',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
};

function maskKey(value) {
  if (!value) return '';
  if (value.length <= 8) return 'Saved';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  await ensureProfile(user);

  if (req.method === 'PATCH') {
    const { starter_provider: starterProvider } = getJsonBody(req);
    if (!starterProviders.has(starterProvider)) {
      return res.status(400).json({ message: 'Choose OpenRouter or Groq.' });
    }

    const { error } = await supabase
      .from('profiles')
      .update({ starter_provider: starterProvider, updated_at: new Date().toISOString() })
      .eq('id', user.id);

    if (error) return res.status(500).json({ message: 'Could not update provider.' });
  } else if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  const [{ data: profile }, { data: subscription }, { data: keys }] = await Promise.all([
    supabase.from('profiles').select('id,email,full_name,avatar_url,starter_provider').eq('id', user.id).maybeSingle(),
    supabase.from('subscriptions').select('plan,status,whop_membership_id,current_period_end,canceled_at,updated_at').eq('user_id', user.id).maybeSingle(),
    supabase.from('user_api_keys').select('provider,key_hint,updated_at').eq('user_id', user.id),
  ]);

  const plan = subscription?.status === 'active' ? subscription.plan : 'free';
  const starterProvider = profile?.starter_provider || 'openrouter';
  const enabledProviders = plan === 'pro'
    ? ['openai', 'claude', 'openrouter', 'groq', 'gemini', 'deepseek', 'qwen']
    : plan === 'starter'
      ? ['claude', starterProvider]
      : [];

  return res.status(200).json({
    user: { id: user.id, email: user.email },
    profile,
    subscription: subscription || { plan: 'free', status: 'inactive' },
    enabledProviders: enabledProviders.map((provider) => ({ provider, label: providerLabels[provider] || provider })),
    apiKeys: (keys || []).map((key) => ({ provider: key.provider, hint: key.key_hint || maskKey(key.provider), updated_at: key.updated_at })),
  });
}