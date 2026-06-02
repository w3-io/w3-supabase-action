-- One-time seed for w3-supabase-action integration tests.
--
-- Apply via the Supabase SQL editor (or any psql connection). Safe to
-- re-run — drops and recreates every object it owns.
--
-- Everything is placed in the `public` schema with a `_w3_test_`
-- prefix because PostgREST only exposes `public` + `graphql_public`
-- on this project (private schemas would require a project-settings
-- change to expose).
--
-- Objects:
--   public._w3_test_widgets        — CRUD playground
--   public._w3_test_tally(text)    — rpc target
--   storage bucket `_w3-test`      — storage tests
--
-- Auth users are created+torn-down per test via auth.admin — no seed
-- needed there.

-- Table
drop table if exists public._w3_test_widgets cascade;
create table public._w3_test_widgets (
  id          bigserial primary key,
  name        text not null,
  status      text not null default 'pending',
  archived_at timestamptz,
  amount      numeric,
  tags        text[] not null default '{}',
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index _w3_test_widgets_status_idx on public._w3_test_widgets (status);
create index _w3_test_widgets_archived_idx on public._w3_test_widgets (archived_at);

-- RLS deny-by-default; service_role bypasses RLS, so tests work even
-- with this enabled. Keeping it on matches realistic project posture.
alter table public._w3_test_widgets enable row level security;

-- RPC function
drop function if exists public._w3_test_tally(text);
create or replace function public._w3_test_tally(filter_status text default null)
returns jsonb
language plpgsql
security definer
as $$
declare
  total bigint;
begin
  if filter_status is null then
    select count(*) into total from public._w3_test_widgets;
  else
    select count(*) into total from public._w3_test_widgets where status = filter_status;
  end if;
  return jsonb_build_object('row_count', total, 'filter', filter_status);
end;
$$;

-- Storage bucket — RLS on storage.buckets blocks the JS SDK even with
-- service-role, so create it here from SQL where superuser inserts
-- work. Idempotent via insert ... on conflict.
insert into storage.buckets (id, name, public)
values ('_w3-test', '_w3-test', false)
on conflict (id) do nothing;
