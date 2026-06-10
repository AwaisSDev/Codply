import { supabase, publicSupabaseConfig } from '../lib/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  if (!publicSupabaseConfig.anonKey) {
    return res.status(500).json({ message: 'Missing SUPABASE_ANON_KEY environment variable.' });
  }

  // Owner-controlled "free mode" flag (toggle it in the app_settings table).
  // Defaults to false if the row/table is missing, so access stays locked unless
  // you explicitly turn free mode on.
  let freeMode = false;
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('free_mode')
      .eq('id', 1)
      .maybeSingle();
    freeMode = !!(data && data.free_mode);
  } catch (error) {
    console.error('Could not read app_settings.free_mode:', error);
    freeMode = false;
  }

  return res.status(200).json({ ...publicSupabaseConfig, freeMode });
}