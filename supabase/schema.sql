create extension if not exists pgcrypto;

create table if not exists public.contact_imports (
  id uuid primary key default gen_random_uuid(),
  source_filename text,
  imported_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references public.contact_imports(id) on delete set null,
  name text,
  phone text not null,
  normalized_phone text not null unique,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contacts_import_id_idx on public.contacts(import_id);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  session_phone_number text,
  source_filename text,
  message text not null,
  interval_ms integer not null default 2500,
  total_contacts integer not null default 0,
  processed_contacts integer not null default 0,
  success_count integer not null default 0,
  failed_count integer not null default 0,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.campaign_messages (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  phone text not null,
  normalized_phone text not null,
  status text not null,
  detail text,
  sent_at timestamptz not null default now()
);

create index if not exists campaign_messages_campaign_id_idx
  on public.campaign_messages(campaign_id);

create index if not exists campaign_messages_normalized_phone_idx
  on public.campaign_messages(normalized_phone);

alter table public.contact_imports enable row level security;
alter table public.contacts enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_messages enable row level security;
