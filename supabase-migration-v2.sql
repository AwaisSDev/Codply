-- ============================================================================
-- Codeply Supabase migration v2 — run AFTER supabase-waitlist.sql
-- Idempotent: safe to run multiple times in the Supabase SQL Editor.
--
-- EXISTING SCHEMA (echoed for reference, created by supabase-waitlist.sql):
--   waitlist_subscribers(id, full_name, email, source, user_agent, created_at)
--   profiles(id -> auth.users, email, full_name, avatar_url, starter_provider,
--            created_at, updated_at)
--   subscriptions(user_id PK -> auth.users, plan free|starter|pro, status,
--                 whop_membership_id, current_period_end, canceled_at, ...)
--   user_api_keys(user_id+provider PK, encrypted_key, key_hint, created_at,
--                 updated_at)
--   webhook_events(id, type, created_at)
--
-- THIS MIGRATION ADDS:
--   profiles.is_admin                — gates the web admin panel
--   user_settings                    — auto-saved prefs (model, caps, ranking)
--   usage_monthly                    — cumulative token usage per user/month
--   remote_config                    — kill switch / min version / flags
--   app_config (key,value)          — legacy-compatible kill switch read by
--                                      already-installed app versions
--   app_settings (id, free_mode)    — referenced by api/config.js
--   increment_usage() RPC            — atomic usage accumulation
-- ============================================================================

-- ── profiles.is_admin ────────────────────────────────────────────────────────
alter table public.profiles add column if not exists is_admin boolean not null default false;

-- ── user_settings: every user input auto-saves here ─────────────────────────
create table if not exists public.user_settings (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  provider         text not null default 'openrouter',
  model            text not null default 'openai/gpt-4o-mini',
  theme            text not null default 'dark',
  hotkey           text not null default 'Alt+C',
  api_priority     jsonb not null default '[]'::jsonb,  -- e.g. ["claude","openrouter","groq"]
  per_prompt_cap   integer not null default 0,           -- 0 = unlimited
  monthly_cap      bigint  not null default 0,           -- 0 = unlimited
  extra            jsonb not null default '{}'::jsonb,   -- forward-compatible blob
  updated_at       timestamptz not null default now()
);

-- ── usage_monthly: cumulative token usage per user per month ────────────────
create table if not exists public.usage_monthly (
  user_id    uuid not null references auth.users(id) on delete cascade,
  month      text not null,                              -- 'YYYY-MM'
  tokens     bigint  not null default 0,
  requests   integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);

-- ── remote_config: online control panel + kill switch ───────────────────────
create table if not exists public.remote_config (
  id            integer primary key default 1 check (id = 1),  -- single row
  kill_switch   boolean not null default false,
  min_version   text    not null default '0.0.0',
  update_banner text    not null default '',
  feature_flags jsonb   not null default '{}'::jsonb,
  free_mode     boolean not null default false,
  updated_at    timestamptz not null default now()
);
-- (seeded below, after the legacy tables exist)

-- ── Legacy compatibility tables (read by shipped app builds / api/config.js) ─
create table if not exists public.app_config (
  key        text primary key,
  value      text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.app_config (key, value) values ('kill_switch', 'false')
  on conflict (key) do nothing;

create table if not exists public.app_settings (
  id        integer primary key default 1 check (id = 1),
  free_mode boolean not null default false
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- Seed remote_config from the CURRENT live values so behavior doesn't change:
-- kill_switch from app_config, free_mode from app_settings (currently true in
-- your project — free mode stays ON until you flip it in the Admin panel).
insert into public.remote_config (id, kill_switch, free_mode)
values (
  1,
  coalesce((select value = 'true' from public.app_config where key = 'kill_switch'), false),
  coalesce((select free_mode from public.app_settings where id = 1), false)
)
on conflict (id) do nothing;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.user_settings  enable row level security;
alter table public.usage_monthly  enable row level security;
alter table public.remote_config  enable row level security;
alter table public.app_config     enable row level security;
alter table public.app_settings   enable row level security;

-- user_settings: owners read/write their own row only
drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own" on public.user_settings
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own" on public.user_settings
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- usage_monthly: owners can read their usage; writes happen via the
-- increment_usage() RPC (security definer) or service-role API routes.
drop policy if exists "usage_select_own" on public.usage_monthly;
create policy "usage_select_own" on public.usage_monthly
  for select to authenticated using (auth.uid() = user_id);

-- remote_config / app_config / app_settings: world-readable (the app reads
-- these on launch, even signed out). Writes restricted to admins.
drop policy if exists "remote_config_read_all" on public.remote_config;
create policy "remote_config_read_all" on public.remote_config
  for select to anon, authenticated using (true);
drop policy if exists "app_config_read_all" on public.app_config;
create policy "app_config_read_all" on public.app_config
  for select to anon, authenticated using (true);
drop policy if exists "app_settings_read_all" on public.app_settings;
create policy "app_settings_read_all" on public.app_settings
  for select to anon, authenticated using (true);

-- Admin write policies (profiles.is_admin)
create or replace function public.is_admin_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

drop policy if exists "remote_config_admin_write" on public.remote_config;
create policy "remote_config_admin_write" on public.remote_config
  for update to authenticated using (public.is_admin_user()) with check (public.is_admin_user());
drop policy if exists "app_config_admin_write" on public.app_config;
create policy "app_config_admin_write" on public.app_config
  for all to authenticated using (public.is_admin_user()) with check (public.is_admin_user());

-- ── Atomic usage accumulation (callable by the signed-in app) ───────────────
create or replace function public.increment_usage(p_tokens bigint, p_requests integer default 1)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_month text := to_char(now(), 'YYYY-MM');
begin
  if auth.uid() is null then return; end if;
  insert into public.usage_monthly (user_id, month, tokens, requests)
  values (auth.uid(), v_month, greatest(p_tokens, 0), greatest(p_requests, 0))
  on conflict (user_id, month) do update
    set tokens     = usage_monthly.tokens   + greatest(p_tokens, 0),
        requests   = usage_monthly.requests + greatest(p_requests, 0),
        updated_at = now();
end;
$$;
grant execute on function public.increment_usage(bigint, integer) to authenticated;

-- ── Owner read access for the desktop app (writes stay service-role only) ───
drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own" on public.subscriptions
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated using (auth.uid() = id);

-- ── Realtime: let the app live-sync settings changed on the web dashboard ───
do $$
begin
  alter publication supabase_realtime add table public.user_settings;
exception when duplicate_object then null;
end $$;

-- ── To promote yourself to admin, run (replace the email): ──────────────────
-- update public.profiles set is_admin = true where email = 'msiddique@nfciet.edu.pk';
