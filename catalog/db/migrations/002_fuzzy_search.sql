-- =============================================================================
-- 002_fuzzy_search.sql
-- search_components(q): local, index-backed fuzzy lookup.
--
--   select * from search_components('Morel Octav 4 ohm floorstanding');
--   select * from search_components('morel octav', p_impedance => 4, p_category => 'floorstanding');
--   supabase.rpc('search_components', { q: 'Morel Octav', p_impedance: 4, p_category: 'floorstanding' })
--
-- The free-text query is parsed for impedance ("4 ohm", "4Ω", "4-ohm") and
-- category words ("floorstanding", "tower", "bookshelf", "sub"...). Explicit
-- parameters win over what is parsed from the text. Whatever text is left is
-- matched with pg_trgm word_similarity against "brand model", so partial words
-- ("Octav") and typos ("Morrel") still hit, through the GIN index.
--
-- An empty result is the app's signal to fall back to the LLM / external API.
-- =============================================================================

create or replace function public.parse_search_query(
  q text,
  out text_part text,
  out impedance numeric,
  out category text
)
language plpgsql
immutable
set search_path = public
as $$
declare
  s text := lower(coalesce(q, ''));
  m text[];
begin
  -- impedance: "4 ohm", "4ohms", "4-ohm", "4 Ω", "4.0Ω"
  m := regexp_match(s, '(\d+(?:[.,]\d+)?)\s*-?\s*(?:ohms?|Ω|ω)');
  if m is not null then
    impedance := replace(m[1], ',', '.')::numeric;
    s := regexp_replace(s, '(\d+(?:[.,]\d+)?)\s*-?\s*(?:ohms?|Ω|ω)', ' ', 'g');
  end if;

  -- category words (first match wins, word is removed from the text)
  if s ~ '\m(floor\s*-?\s*stand(ing|er|ers)?|floorstand(ing|er|ers)?|towers?)\M' then
    category := 'floorstanding';
    s := regexp_replace(s, '\m(floor\s*-?\s*stand(ing|er|ers)?|floorstand(ing|er|ers)?|towers?)\M', ' ', 'g');
  elsif s ~ '\m(book\s*-?\s*shel(f|ves)|stand\s*-?\s*mounts?|standmounts?)\M' then
    category := 'bookshelf';
    s := regexp_replace(s, '\m(book\s*-?\s*shel(f|ves)|stand\s*-?\s*mounts?|standmounts?)\M', ' ', 'g');
  elsif s ~ '\m(subwoofers?|subs?)\M' then
    category := 'subwoofer';
    s := regexp_replace(s, '\m(subwoofers?|subs?)\M', ' ', 'g');
  elsif s ~ '\m(cent(er|re)s?)\M' then
    category := 'center';
    s := regexp_replace(s, '\m(cent(er|re)s?)\M', ' ', 'g');
  elsif s ~ '\m(headphones?|cans)\M' then
    category := 'headphones';
    s := regexp_replace(s, '\m(headphones?|cans)\M', ' ', 'g');
  end if;

  -- filler words that only add noise to trigram scores
  s := regexp_replace(s, '\m(speakers?|loudspeakers?|variants?|models?|pairs?)\M', ' ', 'g');

  text_part := audio_norm(s);
end $$;


drop function if exists public.search_components(text, numeric, text, int, real);
create or replace function public.search_components(
  q            text,
  p_impedance  numeric default null,
  p_category   text    default null,
  p_limit      int     default 20,
  p_min_score  real    default 0.3,
  p_token_min  real    default 0.5   -- every query word must fuzzy-match at least this well
)
returns table (
  id                     bigint,
  brand                  text,
  model                  text,
  category               text,
  sensitivity_db         numeric,
  nominal_impedance_ohm  numeric,
  rms_watts              numeric,
  specs                  jsonb,
  score                  real
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  parsed    record;
  nq        text;
  v_imp     numeric;
  v_cat     text;
  v_alias   record;
  v_tokens  text[];
begin
  parsed := parse_search_query(q);
  nq     := parsed.text_part;
  v_imp  := coalesce(p_impedance, parsed.impedance);
  v_cat  := coalesce(p_category,  parsed.category);

  -- Rewrite a leading brand alias to the canonical brand ("b and w 702" -> "bowers and wilkins 702").
  if nq <> '' then
    select a.alias_key, b.name_key into v_alias
      from brand_aliases a join brands b on b.id = a.brand_id
     where nq = a.alias_key or nq like a.alias_key || ' %'
     order by length(a.alias_key) desc
     limit 1;
    if found then
      nq := v_alias.name_key || substr(nq, length(v_alias.alias_key) + 1);
    end if;
  end if;

  -- No free text left (e.g. "4 ohm floorstanding"): filtered browse.
  if nq = '' then
    return query
      select c.id, b.name, c.model, c.category, c.sensitivity_db,
             c.nominal_impedance_ohm, c.rms_watts, c.specs, 1.0::real
        from components c join brands b on b.id = c.brand_id
       where (v_imp is null or c.nominal_impedance_ohm = v_imp)
         and (v_cat is null or c.category = v_cat)
       order by b.name, c.model
       limit p_limit;
    return;
  end if;

  v_tokens := string_to_array(nq, ' ');

  -- `<%` is index-assisted; this threshold is the gate, p_min_score the final cut.
  perform set_config('pg_trgm.word_similarity_threshold', least(p_min_score, 0.3)::text, true);

  return query
    with hits as (
      select c.*, b.name as brand_name,
             greatest(
               word_similarity(nq, c.search_text),
               similarity(nq, c.search_text),
               similarity(nq, c.model_key)
             )
             + case when c.search_text like nq || '%' then 0.15 else 0 end   -- prefix ("morel octav..." )
             + case when c.model_key = nq or c.search_text = nq then 0.25 else 0 end  -- exact
             as s
        from components c
        join brands b on b.id = c.brand_id
       where (nq <% c.search_text or c.search_text like '%' || nq || '%')
         -- per-word gate: "morel octav" must match "octav" too, not just the brand
         and not exists (select 1 from unnest(v_tokens) t
                          where word_similarity(t, c.search_text) < p_token_min)
         and (v_imp is null or c.nominal_impedance_ohm = v_imp)
         and (v_cat is null or c.category = v_cat)
    )
    select h.id, h.brand_name, h.model, h.category, h.sensitivity_db,
           h.nominal_impedance_ohm, h.rms_watts, h.specs, least(h.s, 1.0)::real
      from hits h
     where h.s >= p_min_score
     order by h.s desc, h.brand_name, h.model
     limit p_limit;
end $$;

-- Brand autocomplete / "did you mean" (used by the importer for unknown brands).
create or replace function public.search_brands(q text, p_limit int default 5)
returns table (id bigint, name text, country text, score real)
language sql
stable
set search_path = public, extensions
as $$
  with nq as (select audio_norm(q) as v),
  candidates as (
    select b.id, b.name, b.country, similarity((select v from nq), b.name_key) as s
      from brands b
     where b.name_key % (select v from nq) or b.name_key like (select v from nq) || '%'
    union all
    select b.id, b.name, b.country, similarity((select v from nq), a.alias_key)
      from brand_aliases a join brands b on b.id = a.brand_id
     where a.alias_key % (select v from nq)
  )
  select id, name, country, max(s)::real as score
    from candidates
   group by id, name, country
   order by score desc, name
   limit p_limit
$$;
