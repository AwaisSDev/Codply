-- Codply Supabase schema
-- Run this in Supabase SQL Editor.
-- Vercel env vars required:
-- SUPABASE_URL
-- SUPABASE_ANON_KEY
-- SUPABASE_SERVICE_ROLE_KEY
-- WHOP_API_KEY
-- WHOP_STARTER_PLAN_ID
-- WHOP_PRO_PLAN_ID
-- WHOP_WEBHOOK_SECRET
-- API_KEY_ENCRYPTION_SECRET (32+ chars)
-- SITE_URL (example: https://codeply.online)

create table if not exists public.waitlist_subscribers (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  email text not null unique,
  source text not null default 'codply_landing',
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  starter_provider text not null default 'openrouter' check (starter_provider in ('openrouter', 'groq')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'starter', 'pro')),
  status text not null default 'inactive' check (status in ('inactive', 'active', 'past_due', 'canceled')),
  whop_membership_id text,
  current_period_end timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_api_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'claude', 'openrouter', 'groq', 'gemini', 'deepseek', 'qwen', 'custom')),
  encrypted_key text not null,
  key_hint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create table if not exists public.webhook_events (
  id text primary key,
  type text,
  created_at timestamptz not null default now()
);

alter table public.waitlist_subscribers enable row level security;
alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.user_api_keys enable row level security;
alter table public.webhook_events enable row level security;

-- Browser clients should use Supabase Auth only. App data is read/written by Vercel API routes with service role.
-- Do not add anon SELECT policies for subscriptions or encrypted keys.

drop policy if exists "Allow public waitlist inserts" on public.waitlist_subscribers;
create policy "Allow public waitlist inserts"
  on public.waitlist_subscribers
  for insert
  to anon
  with check (
    email is not null
    and length(email) between 5 and 320
    and position('@' in email) > 1
  );