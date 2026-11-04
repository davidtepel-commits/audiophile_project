-- =============================================================================
-- 001_catalog_schema.sql
-- Master directory of hi-fi brands + components, with trigram fuzzy search.
-- Works on vanilla PostgreSQL 13+ and on Supabase (extensions live in the
-- `extensions` schema, which Supabase already creates).
-- =============================================================================

create schema if not exists extensions;
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;

-- -----------------------------------------------------------------------------
-- audio_norm(text): the single normalisation rule used for keys and search.
--   "Bowers & Wilkins 702 S3" -> "bowers and wilkins 702 s3"
--   "Morel  Octave-6 (Floor)" -> "morel octave 6 floor"
-- unaccent() is only STABLE, so we pin the dictionary and declare the wrapper
-- IMMUTABLE; that is what lets us use it in generated columns and indexes.
-- The JS twin of this function lives in src/normalize.js (normKey) and the two
-- MUST stay in sync.
-- -----------------------------------------------------------------------------
create or replace function public.audio_norm(input text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select btrim(
           regexp_replace(
             replace(lower(extensions.unaccent('extensions.unaccent'::regdictionary, input)), '&', ' and '),
             '[^a-z0-9]+', ' ', 'g'
           )
         )
$$;

-- -----------------------------------------------------------------------------
-- Brands
-- -----------------------------------------------------------------------------
create table if not exists public.brands (
  id          bigint generated always as identity primary key,
  name        text not null,
  name_key    text generated always as (public.audio_norm(name)) stored,
  country     text,                       -- ISO 3166-1 alpha-2, best effort
  categories  text[] not null default '{}',
  website     text,
  verified    boolean not null default false,  -- false = auto-created by an import
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint brands_name_key_uniq unique (name_key)
);

create index if not exists brands_name_trgm
  on public.brands using gin (name_key extensions.gin_trgm_ops);

-- Alternate spellings: "B&W" -> Bowers & Wilkins, "JMlab" -> Focal, ...
create table if not exists public.brand_aliases (
  alias_key  text primary key,
  alias      text not null,
  brand_id   bigint not null references public.brands(id) on delete cascade
);
create index if not exists brand_aliases_brand_idx on public.brand_aliases (brand_id);

-- -----------------------------------------------------------------------------
-- Components
-- -----------------------------------------------------------------------------
create table if not exists public.components (
  id                     bigint generated always as identity primary key,
  brand_id               bigint not null references public.brands(id) on delete cascade,
  model                  text not null,
  model_key              text generated always as (public.audio_norm(model)) stored,
  category               text not null default 'other',
  sensitivity_db         numeric(5,2),   -- dB SPL @ 2.83V or 1W / 1m
  nominal_impedance_ohm  numeric(5,2),
  rms_watts              numeric(9,2),   -- continuous / RMS power (rating or handling)
  specs                  jsonb not null default '{}'::jsonb,  -- every other column from the source
  search_text            text not null default '',            -- maintained by trigger
  source                 text,
  import_batch_id        bigint,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint components_brand_model_uniq unique (brand_id, model_key),
  constraint components_category_chk check (category in (
    'floorstanding','bookshelf','center','subwoofer','in_wall','on_wall','soundbar',
    'headphones','iem',
    'integrated_amp','power_amp','preamp','receiver','phono_stage','headphone_amp',
    'dac','streamer','cd_player','turntable','cartridge',
    'car_component','car_coaxial','car_subwoofer','car_amp',
    'driver','cable','other'
  )),
  constraint components_sensitivity_chk check (sensitivity_db is null or sensitivity_db between 50 and 130),
  constraint components_impedance_chk   check (nominal_impedance_ohm is null or nominal_impedance_ohm between 0.5 and 600),
  constraint components_rms_chk         check (rms_watts is null or rms_watts between 0 and 100000)
);

-- The workhorse: trigram GIN index for `%`, `<%`, ILIKE and similarity().
create index if not exists components_search_trgm
  on public.components using gin (search_text extensions.gin_trgm_ops);
create index if not exists components_filter_idx
  on public.components (category, nominal_impedance_ohm);
create index if not exists components_brand_idx on public.components (brand_id);

-- search_text = normalised "brand model", computed on write so reads never join.
create or replace function public.components_set_search_text()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  select audio_norm(b.name || ' ' || new.model)
    into new.search_text
    from brands b where b.id = new.brand_id;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists components_search_text_trg on public.components;
create trigger components_search_text_trg
  before insert or update of model, brand_id, sensitivity_db, nominal_impedance_ohm, rms_watts, category, specs
  on public.components
  for each row execute function public.components_set_search_text();

-- Keep component search_text correct if a brand is renamed.
create or replace function public.brands_propagate_rename()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.name is distinct from old.name then
    update components set model = model where brand_id = new.id;  -- fires the trigger above
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists brands_rename_trg on public.brands;
create trigger brands_rename_trg
  before update on public.brands
  for each row execute function public.brands_propagate_rename();

-- -----------------------------------------------------------------------------
-- Import audit trail (CLI + admin dashboard both write here)
-- -----------------------------------------------------------------------------
create table if not exists public.import_batches (
  id            bigint generated always as identity primary key,
  filename      text,
  origin        text not null default 'cli',     -- 'cli' | 'admin'
  rows_total    int  not null default 0,
  rows_inserted int  not null default 0,
  rows_updated  int  not null default 0,
  rows_rejected int  not null default 0,
  new_brands    text[] not null default '{}',
  errors        jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

do $$ begin
  alter table public.components
    add constraint components_import_batch_fk
    foreign key (import_batch_id) references public.import_batches(id) on delete set null;
exception when duplicate_object then null; end $$;
