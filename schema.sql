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
