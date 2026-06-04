import { requireUser, getJsonBody } from './auth.js';

const planEnv = {
  starter: 'WHOP_STARTER_PLAN_ID',
  pro: 'WHOP_PRO_PLAN_ID',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  const { plan } = getJsonBody(req);
  if (!['starter', 'pro'].includes(plan)) {
    return res.status(400).json({ message: 'Choose a valid plan.' });
  }

  const whopApiKey = process.env.WHOP_API_KEY;
  const planId = process.env[planEnv[plan]];
  if (!whopApiKey || !planId) {
    return res.status(500).json({ message: 'Whop checkout is not configured yet.' });
  }

  const origin = process.env.SITE_URL || `https://${req.headers.host}`;
  const metadata = { user_id: user.id, email: user.email, plan };

  try {
    const response = await fetch('https://api.whop.com/api/v1/checkout_configurations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${whopApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: planId,
        metadata,
        redirect_url: `${origin}/#dashboard`,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Whop checkout failed:', data);
      return res.status(502).json({ message: 'Could not create checkout. Check Whop plan env vars.' });
    }

    const checkoutUrl = data.purchase_url?.startsWith('http')
      ? data.purchase_url
      : `https://whop.com${data.purchase_url || `/checkout/${planId}`}`;

    return res.status(200).json({ checkoutUrl });
  } catch (error) {
    console.error('Create checkout failed:', error);
    return res.status(500).json({ message: 'Could not create checkout right now.' });
  }
}