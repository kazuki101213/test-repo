-- ローカル検証用: Supabase が提供する auth / storage / ロールの最小スタブ
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text
);
alter table storage.objects enable row level security;

-- CI uses plain PostgreSQL. Keep the schema checks running without executing
-- Supabase's external scheduler or Vault integration in this disposable DB.
create schema if not exists cron;
create or replace function cron.schedule(text, text, text) returns bigint
language sql as $$ select 1::bigint $$;

create schema if not exists vault;
create or replace function vault.create_secret(text, text) returns uuid
language sql as $$ select gen_random_uuid() $$;
