'use strict';
/**
 * Set-based bulk importer:
 *   rows -> validate in JS -> COPY-like unnest() into a temp staging table
 *   -> resolve brands (name or alias) in SQL -> one INSERT ... ON CONFLICT upsert.
 * Dry runs execute the exact same SQL inside a transaction and ROLLBACK, so the
 * preview counts (inserted / updated / new brands) are what a commit will do.
 */
const { mapHeaders, normalizeRow, normKey } = require('./normalize');

/** Damerau-Levenshtein (optimal string alignment) - catches "Dynaudoi" -> "Dynaudio". */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Is `input` a probable typo of master-list brand `candidate`? */
function isLikelyTypo(input, candidate, score, threshold) {
  if (score >= threshold) return true;
  const a = normKey(input); const b = normKey(candidate);
  return a.length >= 5 && score >= 0.35 && editDistance(a, b) <= (a.length >= 8 ? 2 : 1);
}

const STAGE_CHUNK = 5000;

/** Upsert the brand master list (data/brands.json shape). */
async function upsertBrands(client, brands, { source = 'seed', verified = true } = {}) {
  if (!brands.length) return { inserted: 0, updated: 0, aliases: 0 };
  const { rows } = await client.query(
    `insert into brands (name, country, categories, website, verified, source)
     select x.name, x.country, coalesce(x.categories, '{}'), x.website, $2, $3
       from jsonb_to_recordset($1::jsonb) as x(name text, country text, categories text[], website text)
     on conflict (name_key) do update
        set country    = coalesce(excluded.country, brands.country),
            categories = (select array(select distinct unnest(brands.categories || excluded.categories))),
            website    = coalesce(excluded.website, brands.website),
            verified   = brands.verified or excluded.verified
     returning (xmax = 0) as inserted`,
    [JSON.stringify(brands.map((b) => ({ name: b.name, country: b.country || null, categories: b.categories || [], website: b.website || null }))), verified, source],
  );
  const aliasRows = brands.flatMap((b) => (b.aliases || []).map((alias) => ({ alias, brand: b.name })));
  let aliases = 0;
  if (aliasRows.length) {
    const r = await client.query(
      `insert into brand_aliases (alias_key, alias, brand_id)
       select distinct on (audio_norm(x.alias)) audio_norm(x.alias), x.alias, b.id
         from jsonb_to_recordset($1::jsonb) as x(alias text, brand text)
         join brands b on b.name_key = audio_norm(x.brand)
        where audio_norm(x.alias) <> '' and audio_norm(x.alias) <> b.name_key
       on conflict (alias_key) do update set brand_id = excluded.brand_id, alias = excluded.alias`,
      [JSON.stringify(aliasRows)],
    );
    aliases = r.rowCount;
  }
  return { inserted: rows.filter((r) => r.inserted).length, updated: rows.filter((r) => !r.inserted).length, aliases };
}

/**
 * Validate raw rows (no DB). Exposed separately so the UI can show column mapping instantly.
 */
function validateRows(headers, rawRows, lines = []) {
  const { map, unmapped, missing } = mapHeaders(headers);
  const valid = [];
  const rejected = [];
  const warnings = [];
  if (missing.length) {
    return { columnMap: map, unmappedColumns: unmapped, missingColumns: missing, valid, rejected: rawRows.map((_, i) => ({ row: lines[i] ?? i + 2, errors: [`missing required column(s): ${missing.join(', ')}`] })), warnings };
  }
  rawRows.forEach((raw, i) => {
    const rowNo = lines[i] ?? i + 2; // spreadsheet row number (header = 1)
    const { record, errors, warnings: w } = normalizeRow(raw, map);
    if (w.length) warnings.push({ row: rowNo, messages: w });
    if (record) valid.push({ ...record, rowNo });
    else rejected.push({ row: rowNo, errors, raw });
  });
  return { columnMap: map, unmappedColumns: unmapped, missingColumns: missing, valid, rejected, warnings };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{headers: string[], rows: object[]}} parsed
 * @param {{dryRun?: boolean, allowNewBrands?: boolean, filename?: string, origin?: string, source?: string}} opts
 */
async function importComponents(pool, parsed, opts = {}) {
  const {
    dryRun = false, allowNewBrands = true, filename = null, origin = 'cli', source = filename,
    // unknown brand whose closest master-list match scores >= this is treated as a typo of it
    // ("Morrel" -> Morel). Set to 1.01 to disable auto-correction.
    brandAutocorrect = 0.6,
  } = opts;
  const v = validateRows(parsed.headers, parsed.rows, parsed.lines);
  const report = {
    filename,
    dryRun,
    rowsTotal: parsed.rows.length,
    columnMap: v.columnMap,
    unmappedColumns: v.unmappedColumns,
    missingColumns: v.missingColumns,
    inserted: 0,
    updated: 0,
    duplicatesInFile: 0,
    rejected: v.rejected.length,
    newBrands: [],
    unknownBrands: [],
    errors: v.rejected.slice(0, 500).map(({ row, errors }) => ({ row, errors })),
    warnings: v.warnings.slice(0, 500),
    batchId: null,
    preview: [],
  };
  if (!v.valid.length) return report;

  const client = await pool.connect();
  try {
    await client.query('begin');

    let batchId = null;
    if (!dryRun) {
      const b = await client.query(`insert into import_batches (filename, origin, rows_total) values ($1, $2, $3) returning id`, [filename, origin, parsed.rows.length]);
      batchId = b.rows[0].id;
      report.batchId = batchId;
    }

    await client.query(`
      create temp table _stage (
        row_no int, brand text, model text, category text,
        sensitivity_db numeric, nominal_impedance_ohm numeric, rms_watts numeric, specs jsonb,
        brand_id bigint
      ) on commit drop`);

    for (let i = 0; i < v.valid.length; i += STAGE_CHUNK) {
      const chunk = v.valid.slice(i, i + STAGE_CHUNK);
      await client.query(
        `insert into _stage (row_no, brand, model, category, sensitivity_db, nominal_impedance_ohm, rms_watts, specs)
         select * from unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::jsonb[])`,
        [
          chunk.map((r) => r.rowNo), chunk.map((r) => r.brand), chunk.map((r) => r.model), chunk.map((r) => r.category),
          chunk.map((r) => r.sensitivity_db), chunk.map((r) => r.nominal_impedance_ohm), chunk.map((r) => r.rms_watts),
          chunk.map((r) => JSON.stringify(r.specs || {})),
        ],
      );
    }

    // 1. resolve by canonical name, then alias
    const resolveSql = `
      update _stage s set brand_id = coalesce(
        (select b.id from brands b where b.name_key = audio_norm(s.brand)),
        (select a.brand_id from brand_aliases a where a.alias_key = audio_norm(s.brand)))
      where s.brand_id is null`;
    await client.query(resolveSql);

    const { rows: unknown } = await client.query(
      `select min(brand) as brand, count(*)::int as rows from _stage where brand_id is null group by audio_norm(brand) order by 2 desc`);

    if (unknown.length) {
      // 1b. typo auto-correction against the master list, before anything gets created
      for (const u of unknown.slice(0, 200)) {
        const { rows: sug } = await client.query(
          `select id, name, score from search_brands($1, 3) where score >= 0.35`, [u.brand]);
        const entry = { brand: u.brand, rows: u.rows, suggestions: sug.map((s) => s.name), action: null };
        if (sug[0] && isLikelyTypo(u.brand, sug[0].name, sug[0].score, brandAutocorrect)) {
          await client.query(`update _stage set brand_id = $1 where brand_id is null and audio_norm(brand) = audio_norm($2)`, [sug[0].id, u.brand]);
          entry.action = `mapped to ${sug[0].name}`;
        }
        report.unknownBrands.push(entry);
      }

      if (allowNewBrands) {
        const { rows: created } = await client.query(
          `insert into brands (name, verified, source)
           select distinct on (audio_norm(brand)) brand, false, $1 from _stage where brand_id is null
           on conflict (name_key) do nothing
           returning name`, [`import:${filename || origin}`]);
        report.newBrands = created.map((r) => r.name);
        await client.query(resolveSql);
        for (const u of report.unknownBrands) if (!u.action) u.action = 'created (unverified)';
      } else {
        const { rows: dropped } = await client.query(`delete from _stage where brand_id is null returning row_no, brand`);
        report.rejected += dropped.length;
        for (const u of report.unknownBrands) if (!u.action) u.action = 'rejected';
        for (const d of dropped.slice(0, 500)) report.errors.push({ row: d.row_no, errors: [`unknown brand "${d.brand}" (enable "allow new brands" or add it to data/brands.json)`] });
      }
    }

    // 2. collapse duplicates inside the file (last row wins) and upsert
    const { rows: dupes } = await client.query(
      `select count(*) - count(distinct (brand_id, audio_norm(model))) as n from _stage`);
    report.duplicatesInFile = Number(dupes[0].n);

    const { rows: up } = await client.query(
      `insert into components as c (brand_id, model, category, sensitivity_db, nominal_impedance_ohm, rms_watts, specs, source, import_batch_id)
       select distinct on (brand_id, audio_norm(model))
              brand_id, model, category, sensitivity_db, nominal_impedance_ohm, rms_watts, specs, $1, $2
         from _stage
        order by brand_id, audio_norm(model), row_no desc
       on conflict (brand_id, model_key) do update set
              model                 = excluded.model,
              category              = case when excluded.category = 'other' then c.category else excluded.category end,
              sensitivity_db        = coalesce(excluded.sensitivity_db, c.sensitivity_db),
              nominal_impedance_ohm = coalesce(excluded.nominal_impedance_ohm, c.nominal_impedance_ohm),
              rms_watts             = coalesce(excluded.rms_watts, c.rms_watts),
              specs                 = c.specs || excluded.specs,
              source                = coalesce(excluded.source, c.source),
              import_batch_id       = coalesce(excluded.import_batch_id, c.import_batch_id)
       returning c.id, (xmax = 0) as inserted`,
      [source, batchId],
    );
    report.inserted = up.filter((r) => r.inserted).length;
    report.updated = up.length - report.inserted;

    const { rows: preview } = await client.query(
      `select s.row_no, b.name as brand, s.model, s.category, s.sensitivity_db, s.nominal_impedance_ohm, s.rms_watts,
              exists (select 1 from components c where c.brand_id = s.brand_id and c.model_key = audio_norm(s.model) and c.created_at < now()) as existed
         from _stage s join brands b on b.id = s.brand_id order by s.row_no limit 200`);
    report.preview = preview;

    if (dryRun) {
      await client.query('rollback');
    } else {
      await client.query(
        `update import_batches set rows_inserted = $2, rows_updated = $3, rows_rejected = $4, new_brands = $5, errors = $6 where id = $1`,
        [batchId, report.inserted, report.updated, report.rejected, report.newBrands, JSON.stringify(report.errors.slice(0, 200))]);
      await client.query('commit');
    }
    return report;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertBrands, importComponents, validateRows, editDistance, isLikelyTypo };
