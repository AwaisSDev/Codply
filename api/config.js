import { publicSupabaseConfig } from './supabaseClient.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  if (!publicSupabaseConfig.anonKey) {
    return res.status(500).json({ message: 'Missing SUPABASE_ANON_KEY environment variable.' });
  }

  return res.status(200).json(publicSupabaseConfig);
}