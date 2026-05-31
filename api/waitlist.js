import { supabase } from './supabaseClient.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  try {
    const { email, full_name: fullName } = getBody(req);
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedName = String(fullName || '').trim();

    if (!emailPattern.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Enter a valid email address.' });
    }

    const { error } = await supabase
      .from('waitlist_subscribers')
      .insert({
        email: normalizedEmail,
        full_name: normalizedName || null,
        source: 'codply_landing',
        user_agent: req.headers['user-agent'] || null,
      });

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ message: 'You are already on the waitlist.' });
      }

      console.error('Supabase waitlist insert failed:', error);
      return res.status(500).json({ message: 'Could not join right now. Please try again.' });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Waitlist API failed:', error);
    return res.status(500).json({ message: 'Could not join right now. Please try again.' });
  }
}
