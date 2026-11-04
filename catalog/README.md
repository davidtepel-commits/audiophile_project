# Audiophile Catalog: local brand & component directory

A pre-seeded master directory of hi-fi brands and components, so the app can answer
searches like **"Morel Octav"** from Postgres in milliseconds and call the LLM or external API
only when the local catalog has no match.

```
data/brands.src.tsv ──build──► data/brands.json ─┐
data/components/*.csv|xlsx|json ─────────────────┼─► scripts/ingest.js ─┐
vendor spreadsheet ──drag & drop──► admin/ ──────┘   (shared importer)  ├─► Postgres / Supabase
                                                                         │    brands, brand_aliases,
app ──► search_components('Morel Octav 4 ohm floorstanding') ◄───────────┘    components (+ pg_trgm GIN)
         └─ 0 rows? ─► fall back to LLM lookup
```

## Quick start

```bash
npm install
cp .env.example .env        # set DATABASE_URL and ADMIN_TOKEN
```

```bash
export $(grep -v '^#' .env | xargs)
npm run seed                # migrations + 304 brands + data/components/*
npm run search -- "Morel Octav 4 ohm floorstanding"
npm run admin               # http://localhost:8787
```

## 1. Ingestion script: `scripts/ingest.js`

| Command | What it does |
|---|---|
| `npm run ingest` | Upserts `data/brands.json` and every file in `data/components/` |
| `npm run ingest -- --file dumps/kef.xlsx --file dumps/focal.csv` | Imports specific files |
| `npm run ingest -- --dir ~/spec-dumps` | Imports every `.csv/.tsv/.json/.ndjson/.xlsx` in a folder |
| `npm run ingest -- --url https://…/specs.json` | Imports a remote open dataset (CSV or JSON) |
| `npm run ingest -- --dry-run --no-new-brands --file x.csv` | Validates only. Unknown brands are rejected. |
| `npm run ingest -- --brands-only` | Upserts only the brand master list |

- **Brand master list.** `data/brands.src.tsv` holds 304 brands across speakers, amps, sources,
  turntables and cartridges, headphones, car audio, drivers and cables. Each entry has a country,
  categories and aliases (`B&W`, `JMlab`, `Simaudio`…). Edit the TSV, then run
  `npm run build:brands`. A JSON file shaped `{ "brands": [...] }` dropped into
  `data/components/` is also loaded as brands.
- **Flexible sources.** It accepts CSV/TSV (the delimiter is detected, `#` comments are allowed),
  XLSX, JSON arrays, `{components|items|data|rows: [...]}` and NDJSON. Nested spec objects are
  flattened.
- **Column mapping.** `Manufacturer`, `Model Name`, `Sensitivity (dB/2.83V/1m)`,
  `Impedance (ohms)`, `Power Handling RMS`, `Speaker Type` and similar headers are mapped
  automatically. `Peak Power` and `Min Impedance` are deliberately not mapped. Every unmapped
  column is kept in `components.specs` (jsonb), so nothing in the vendor sheet is lost.
- **Value parsing.** `"87,5 dB"`, `"4 Ω"`, `"4-8 ohm"` (stored as 4, with a warning),
  `"100W RMS / 200W peak"` (stored as 100), `"2 x 75W"` (75) and `"1.2kW"` all parse. Values
  outside sane ranges are rejected with a row number.
- **Set-based upsert.** Rows go into a temp staging table through `unnest()`. Brands are resolved
  by name, then alias, then typo correction (`Morrel` → Morel, `Dynaudoi` → Dynaudio). After
  that, a single `INSERT … ON CONFLICT (brand_id, model_key)` runs. Duplicates within a file are
  merged (the last row wins). **Blank cells never overwrite stored values.**
- **Unknown brands** are created with `verified = false` (unless you pass `--no-new-brands`), and
  the report lists "did you mean" suggestions.
- Every run is recorded in `import_batches`, and each component points at the batch that last
  touched it.

## 2. Fuzzy search: `db/migrations/002_fuzzy_search.sql`

```sql
select * from search_components('Morel Octav 4 ohm floorstanding');
select * from search_components('morel octav', p_impedance => 4, p_category => 'floorstanding');
```
```js
// Supabase client (anon key is fine: read-only RLS policies are in 003)
const { data } = await supabase.rpc('search_components', { q: 'Morel Octav 4 ohm floorstanding' });
if (!data.length) return askLLM(query);   // the only time you pay for an external call
```

How it works:
- `audio_norm()` is the single normalisation rule: unaccent, lowercase, `&`→`and`, punctuation
  becomes spaces. It is IMMUTABLE, so it can back the generated `name_key` and `model_key`
  columns. `components.search_text` (`"morel octave 6 floorstanding"`) is maintained by a
  trigger and indexed with **GIN `gin_trgm_ops`**.
- The query text is parsed first. Impedance (`4 ohm`, `4Ω`, `4-ohm`) and category words
  (`floorstanding`, `tower`, `bookshelf`, `sub`, `center`, `headphones`) become exact filters.
  A leading brand alias is rewritten (`b&w 705` → `bowers and wilkins 705`).
- Candidates come from the index through `word_similarity` (`<%`). **Every query word must also
  fuzzy-match on its own**, so "Morel Octav" returns the Octave models, not every Morel product.
- Ranking: trigram score, plus a prefix bonus, plus an exact-match bonus.

Results with the example data:

| Query | Result |
|---|---|
| `Morel Octav 4 ohm floorstanding` | Octave 6 Floorstanding (4 Ω), Octave 8 Floorstanding (4 Ω). The 8 Ω variant is excluded. |
| `morell octave` | All 6 Morel Octave models |
| `klipsh rp 8000` | Klipsch RP-8000F II |
| `b&w 705` | Bowers & Wilkins 705 S3 |
| `Sonus Faber Olympica` | 0 rows, so the app falls back to the LLM |

**Performance:** with 250k components loaded, a search takes about 20–35 ms end to end, and the
plan uses a bitmap index scan on `components_search_trgm`.

`search_brands(q)` is also available for brand autocomplete.

## 3. Bulk CSV updater: `admin/`

`ADMIN_TOKEN=… npm run admin` starts a small Express server with a single-page dashboard:

1. **Drag and drop** a CSV, TSV, XLSX or JSON spec dump with Brand, Model, Sensitivity, Nominal
   Impedance and RMS Wattage columns.
2. A **dry-run preview** shows the exact count of rows that will be inserted, updated and
   rejected, plus new brands. The real SQL runs and is then rolled back. The preview also shows
   column-mapping chips, the brands that were auto-corrected or created, a row-by-row
   new/update preview, and a list of row-numbered errors and warnings.
3. **Commit import** writes the batch. The "Recent imports" table and the header stats refresh.
4. A **Search tester** panel runs `search_components()` live.

API (all routes need `Authorization: Bearer $ADMIN_TOKEN`): `POST /api/imports?dryRun=1`,
`POST /api/imports`, `GET /api/imports`, `GET /api/search?q=`, `GET /api/stats`. Uploads are
limited to 25 MB (set `MAX_UPLOAD_MB` to change this).

> The admin server connects with `DATABASE_URL` (on Supabase, the `postgres` role), so it bypasses
> RLS. Run it on an internal network or behind your existing auth, not on the public internet.

## Supabase notes

- Use the **session pooler** connection string (port 5432) for `DATABASE_URL`, not the
  transaction pooler. The importer uses temp tables inside a transaction.
- The migrations create `pg_trgm` and `unaccent` in the `extensions` schema, which is the
  Supabase default. If your project already has `pg_trgm` installed in `public`, move it first:
  `alter extension pg_trgm set schema extensions;`.
- `003_supabase_rls.sql` turns on RLS with public read policies on the catalog and grants
  `execute` on the search functions to `anon` and `authenticated`. On plain Postgres it skips
  itself.

## Tests

```bash
npm test                                        # parser/normalisation unit tests
```

```bash
TEST_DATABASE_URL=postgres://…/scratch_db npm test   # + DB integration (truncates catalog tables!)
```

## ⚠️ Data caveat

`data/components/example_spec_dump.csv` and `test/fixtures/` hold **placeholder spec values**.
They exist to exercise the pipeline (messy units, typos, a missing brand, an out-of-range value)
and are **not verified manufacturer data**. Replace them with real vendor spec sheets before
production. Brand countries in `brands.src.tsv` are a best effort and worth a quick review.
