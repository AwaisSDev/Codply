import { Whop } from '@whop/sdk';
import { supabase } from '../lib/supabaseClient.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function resolvePlan(data) {
  const metadataPlan = data?.metadata?.plan || data?.checkout_configuration?.metadata?.plan;
  if (['starter', 'pro'].includes(metadataPlan)) return metadataPlan;

  const planId = data?.plan?.id || data?.plan_id || data?.checkout_configuration?.plan?.id;
  if (planId === process.env.WHOP_PRO_PLAN_ID) return 'pro';
  if (planId === process.env.WHOP_STARTER_PLAN_ID) return 'starter';
  return null;
}

function resolveUserId(data) {
  return data?.metadata?.user_id || data?.checkout_configuration?.metadata?.user_id || data?.user_id || null;
}

async function upsertSubscription({ userId, plan, status, membershipId, periodEnd, canceledAt }) {
  if (!userId || !plan) return;
  await supabase.from('subscriptions').upsert({
    user_id: userId,
    plan,
    status,
    whop_membership_id: membershipId || null,
    current_period_end: periodEnd || null,
    canceled_at: canceledAt || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method not allowed');
  }

  try {
    const whop = new Whop({
      apiKey: process.env.WHOP_API_KEY,
      webhookKey: Buffer.from(process.env.WHOP_WEBHOOK_SECRET || '').toString('base64'),
    });

    const rawBody = await readRawBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]));
    const webhookData = whop.webhooks.unwrap(rawBody, { headers });
    const eventId = headers['webhook-id'] || webhookData.id || null;

    if (eventId) {
      const { error } = await supabase.from('webhook_events').insert({ id: eventId, type: webhookData.type });
      if (error?.code === '23505') return res.status(200).send('Duplicate');
    }

    const data = webhookData.data || {};
    const userId = resolveUserId(data);
    const plan = resolvePlan(data);
    const membershipId = data.membership_id || data.membership?.id || data.id || null;
    const periodEnd = data.current_period_end || data.renewal_period_end || data.expires_at || null;

    if (['payment.succeeded', 'membership.activated'].includes(webhookData.type)) {
      await upsertSubscription({ userId, plan, status: 'active', membershipId, periodEnd, canceledAt: null });
    }

    if (['membership.deactivated', 'membership.cancelled', 'membership.canceled', 'payment.failed'].includes(webhookData.type)) {
      await upsertSubscription({ userId, plan: plan || 'free', status: 'inactive', membershipId, periodEnd, canceledAt: new Date().toISOString() });
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Whop webhook failed:', error);
    return res.status(400).send('Invalid webhook');
  }
}