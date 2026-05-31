-- Codply waitlist table for Supabase
-- Run this in Supabase SQL Editor.
-- In Vercel, add environment variables:
-- SUPABASE_URL = your Supabase project URL
-- SUPABASE_SERVICE_ROLE_KEY = your Supabase service role key (server-side only; never expose in browser cod  e)

create table if not exists public.waitlist_subscribers (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  email text not null unique,
  source text not null default 'codply_landing',
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.waitlist_subscribers enable row level security;

-- No anon SELECT/INSERT policy is needed because Vercel writes through a serverless API
-- using SUPABASE_SERVICE_ROLE_KEY. This keeps the table private from browser clients.
