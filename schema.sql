-- Run this in Supabase Dashboard → SQL Editor

create table if not exists public.saved_gifts (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade not null,
  name          text        not null,
  description   text,
  price         text,
  category      text,
  emoji         text,
  amazon_url    text,
  image_url     text,
  search_terms  text,
  occasion      text,
  recipient     text,
  budget_min    integer,
  budget_max    integer,
  created_at    timestamptz default now()
);

alter table public.saved_gifts enable row level security;

create policy "select own" on public.saved_gifts
  for select using (auth.uid() = user_id);

create policy "insert own" on public.saved_gifts
  for insert with check (auth.uid() = user_id);

create policy "delete own" on public.saved_gifts
  for delete using (auth.uid() = user_id);

-- Public profile row per user, looked up by username so others can find and follow you.
create table if not exists public.user_profiles (
  id            uuid        default gen_random_uuid() primary key,
  user_id       uuid        references auth.users(id) on delete cascade unique not null,
  username      text        unique not null,
  display_name  text,
  profile_data  jsonb       default '{}'::jsonb,
  updated_at    timestamptz default now()
);

alter table public.user_profiles enable row level security;

create policy "select all" on public.user_profiles
  for select using (true);

create policy "write own" on public.user_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- One-directional follow graph (Instagram/Twitter style — no approval needed).
create table if not exists public.follows (
  follower_id uuid        references auth.users(id) on delete cascade not null,
  followee_id uuid        references auth.users(id) on delete cascade not null,
  created_at  timestamptz default now(),
  primary key (follower_id, followee_id),
  constraint no_self_follow check (follower_id <> followee_id)
);

alter table public.follows enable row level security;

-- Public so anyone can see follower/following lists and counts.
create policy "select all" on public.follows
  for select using (true);

create policy "insert own" on public.follows
  for insert with check (auth.uid() = follower_id);

create policy "delete own" on public.follows
  for delete using (auth.uid() = follower_id);
