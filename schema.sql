-- Run in Supabase SQL Editor for project zoqzdwgyzcoapftjgobk.
create table if not exists public.whister_payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  transaction_id text,
  product text not null check (product = 'premium_2_months'),
  amount integer not null check (amount > 0),
  currency text not null default 'UGX' check (currency = 'UGX'),
  phone_number text not null,
  provider text not null check (provider in ('mtn', 'airtel')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists whister_payment_orders_user_id_idx on public.whister_payment_orders(user_id);
create index if not exists whister_payment_orders_transaction_id_idx on public.whister_payment_orders(transaction_id);
create table if not exists public.whister_premium_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_until timestamptz not null,
  last_payment_reference text,
  updated_at timestamptz not null default now()
);
alter table public.whister_payment_orders enable row level security;
alter table public.whister_premium_access enable row level security;
-- No anonymous write policies. Only the backend service-role client should write these tables.
