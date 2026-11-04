-- =============================================================================
-- 003_supabase_rls.sql  (Supabase only — skipped automatically on plain Postgres
-- because the `anon` / `authenticated` roles do not exist there)
--
-- Catalog is world-readable through PostgREST; writes go through the
-- service-role key (ingest CLI, admin server), which bypasses RLS.
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    raise notice 'anon role not found - not Supabase, skipping RLS setup';
    return;
  end if;

  alter table public.brands         enable row level security;
  alter table public.brand_aliases  enable row level security;
  alter table public.components     enable row level security;
  alter table public.import_batches enable row level security;

  drop policy if exists brands_read on public.brands;
  create policy brands_read on public.brands for select to anon, authenticated using (true);

  drop policy if exists brand_aliases_read on public.brand_aliases;
  create policy brand_aliases_read on public.brand_aliases for select to anon, authenticated using (true);

  drop policy if exists components_read on public.components;
  create policy components_read on public.components for select to anon, authenticated using (true);
  -- import_batches: no policy => only service_role can see it.

  grant execute on function public.search_components(text, numeric, text, int, real, real) to anon, authenticated;
  grant execute on function public.search_brands(text, int) to anon, authenticated;
end $$;
