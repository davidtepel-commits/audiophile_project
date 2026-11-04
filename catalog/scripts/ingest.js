#!/usr/bin/env node
'use strict';
/**
 * Seed / refresh the catalog.
 *
 *   node scripts/ingest.js                         # brands.json + every file in data/components/
 *   node scripts/ingest.js --brands-only
 *   node scripts/ingest.js --file dumps/focal_2026.xlsx --file dumps/kef.csv
 *   node scripts/ingest.js --dir ~/spec-dumps       # every .csv/.tsv/.json/.ndjson/.xlsx in a folder
 *   node scripts/ingest.js --url https://example.org/open-audio-specs.json
 *   node scripts/ingest.js --dry-run --no-new-brands --file sheet.csv
 *
 * A components source may be any CSV/TSV/JSON/NDJSON/XLSX with (at least) Brand + Model
 * columns; Sensitivity / Nominal Impedance / RMS Wattage / Category are mapped from many
 * common header spellings, everything else is preserved in components.specs (jsonb).
 * A JSON file shaped { "brands": [...] } is treated as a brand list instead.
 */
const fs = require('fs');
const path = require('path');
const { createPool } = require('../src/db');
const { parseFile } = require('../src/parse');
const { upsertBrands, importComponents } = require('../src/importer');

const ROOT = path.join(__dirname, '..');
const EXTS = new Set(['.csv', '.tsv', '.txt', '.json', '.ndjson', '.jsonl', '.xlsx']);

function parseArgs(argv) {
  const a = { files: [], dirs: [], urls: [], brands: path.join(ROOT, 'data', 'brands.json'), dryRun: false, allowNewBrands: true, brandsOnly: false, defaults: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => { const v = argv[++i]; if (v == null) throw new Error(`${k} needs a value`); return v; };
    if (k === '--file' || k === '-f') { a.files.push(next()); a.defaults = false; }
    else if (k === '--dir' || k === '-d') { a.dirs.push(next()); a.defaults = false; }
    else if (k === '--url' || k === '-u') { a.urls.push(next()); a.defaults = false; }
    else if (k === '--brands') a.brands = next();
    else if (k === '--no-brands') a.brands = null;
    else if (k === '--brands-only') a.brandsOnly = true;
    else if (k === '--dry-run' || k === '-n') a.dryRun = true;
    else if (k === '--no-new-brands') a.allowNewBrands = false;
    else if (k === '--help' || k === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.defaults) a.dirs.push(path.join(ROOT, 'data', 'components'));
  return a;
}

function listDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith('.'))
    .sort()
    .map((f) => path.join(dir, f));
}

async function loadSource(src) {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { headers: { 'user-agent': 'audiophile-catalog-ingest/1.0' } });
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    const name = new URL(src).pathname.split('/').pop() || 'download';
    return { name: src, buf: Buffer.from(await res.arrayBuffer()), parseAs: name };
  }
  return { name: path.relative(process.cwd(), src) || src, buf: fs.readFileSync(src), parseAs: src };
}

const fmt = (r) =>
  `rows ${r.rowsTotal}  +${r.inserted} new  ~${r.updated} updated  ✗${r.rejected} rejected` +
  (r.duplicatesInFile ? `  (${r.duplicatesInFile} in-file duplicates merged)` : '') +
  (r.newBrands.length ? `\n        new brands (unverified): ${r.newBrands.join(', ')}` : '');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool();
  const tag = args.dryRun ? '[dry-run] ' : '';
  let failed = 0;
  try {
    if (args.brands) {
      const { brands = [] } = JSON.parse(fs.readFileSync(args.brands, 'utf8'));
      const client = await pool.connect();
      try {
        await client.query('begin');
        const r = await upsertBrands(client, brands, { source: path.basename(args.brands), verified: true });
        await client.query(args.dryRun ? 'rollback' : 'commit');
        console.log(`${tag}brands  ${path.basename(args.brands)}: ${brands.length} listed, +${r.inserted} new, ~${r.updated} updated, ${r.aliases} aliases`);
      } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
    }
    if (args.brandsOnly) return;

    const sources = [...args.files, ...args.dirs.flatMap(listDir), ...args.urls];
    if (!sources.length) console.log('no component files found (put spec dumps in data/components/ or pass --file / --dir / --url)');

    for (const s of sources) {
      try {
        const { name, buf, parseAs } = await loadSource(s);
        const parsed = await parseFile(buf, parseAs);

        // A { brands: [...] } JSON dropped in with the component files = extra brand list
        if (parseAs.endsWith('.json')) {
          const j = JSON.parse(buf.toString('utf8'));
          if (j && Array.isArray(j.brands)) {
            const client = await pool.connect();
            try { await client.query('begin'); const r = await upsertBrands(client, j.brands, { source: name }); await client.query(args.dryRun ? 'rollback' : 'commit'); console.log(`${tag}brands  ${name}: +${r.inserted} new, ~${r.updated} updated`); }
            finally { client.release(); }
            continue;
          }
        }

        const report = await importComponents(pool, parsed, { dryRun: args.dryRun, allowNewBrands: args.allowNewBrands, filename: name, origin: 'cli' });
        console.log(`${tag}import  ${name}: ${fmt(report)}`);
        if (report.missingColumns.length) console.log(`        ! missing required column(s): ${report.missingColumns.join(', ')}  (headers: ${parsed.headers.join(', ')})`);
        for (const u of report.unknownBrands) console.log(`        ? brand "${u.brand}" not in master list -> ${u.action}${u.suggestions.length && !u.action.startsWith('mapped') ? ` (did you mean ${u.suggestions.join(' / ')}?)` : ''}`);
        for (const e of report.errors.slice(0, 10)) console.log(`        ✗ row ${e.row}: ${e.errors.join('; ')}`);
        if (report.errors.length > 10) console.log(`        … ${report.errors.length - 10} more rejected rows`);
      } catch (e) {
        failed++;
        console.error(`  FAIL  ${s}: ${e.message}`);
      }
    }
    if (!args.dryRun) {
      const { rows } = await pool.query('select (select count(*) from brands) as brands, (select count(*) from components) as components');
      console.log(`catalog now: ${rows[0].brands} brands, ${rows[0].components} components`);
    }
  } finally {
    await pool.end();
  }
  if (failed) process.exit(2);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
