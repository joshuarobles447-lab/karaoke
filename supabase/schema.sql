-- JM Karaoke Rental Davao: server-only Supabase storage
-- Run this once in Supabase Dashboard → SQL Editor.

create table if not exists public.jm_admins (
  email text primary key,
  salt text not null,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.jm_packages (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.jm_bookings (
  id text primary key,
  package_id text not null,
  booking_date date not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A private, admin-only customer index. It stores the minimum needed for
-- customer tracking; delivery locations remain on each booking record.
create table if not exists public.jm_customers (
  customer_key text primary key,
  full_name text not null,
  email text,
  facebook text not null,
  facebook_name text not null default '',
  first_booking_at timestamptz not null,
  last_booking_at timestamptz not null,
  booking_count integer not null default 1 check (booking_count > 0),
  updated_at timestamptz not null default now()
);

alter table public.jm_customers alter column email drop not null;
alter table public.jm_customers add column if not exists facebook_name text not null default '';

create index if not exists jm_bookings_package_date_idx
  on public.jm_bookings (package_id, booking_date);

alter table public.jm_admins enable row level security;
alter table public.jm_packages enable row level security;
alter table public.jm_bookings enable row level security;
alter table public.jm_customers enable row level security;

-- Do not grant browser roles any database access. Customer browsers use only
-- the website API; the server alone uses its secret key.
revoke all on table public.jm_admins from anon, authenticated;
revoke all on table public.jm_packages from anon, authenticated;
revoke all on table public.jm_bookings from anon, authenticated;
revoke all on table public.jm_customers from anon, authenticated;

grant select, insert, update, delete on table public.jm_admins to service_role;
grant select, insert, update, delete on table public.jm_packages to service_role;
grant select, insert, update, delete on table public.jm_bookings to service_role;
grant select, insert, update, delete on table public.jm_customers to service_role;
