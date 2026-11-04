#!/usr/bin/env node
'use strict';
/**
 * Admin bulk updater.
 *   ADMIN_TOKEN=... DATABASE_URL=... node admin/server.js   ->  http://localhost:8787
 *
 * POST /api/imports?dryRun=1   multipart "file" -> validation + exact insert/update preview (rolled back)
 * POST /api/imports            multipart "file" -> commit
 * GET  /api/imports            recent batches
 * GET  /api/search?q=...       try the local fuzzy search
 * GET  /api/stats              catalog counts
 */
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { createPool } = require('../src/db');
const { parseFile } = require('../src/parse');
const { importComponents } = require('../src/importer');

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.ADMIN_TOKEN;
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 25);
if (!TOKEN) { console.error('ADMIN_TOKEN must be set - this server writes to the catalog'); process.exit(1); }

const pool = createPool();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });

app.use(express.static(path.join(__dirname, 'public')));

// Every /api route needs the admin token (Bearer). Constant-time compare.
app.use('/api', (req, res, next) => {
  const got = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ error: 'invalid admin token' });
  }
  next();
});

app.get('/api/stats', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select (select count(*) from brands)::int as brands,
             (select count(*) from brands where not verified)::int as unverified_brands,
             (select count(*) from components)::int as components,
             (select max(created_at) from import_batches) as last_import`);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/imports', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `select id, filename, origin, rows_total, rows_inserted, rows_updated, rows_rejected, new_brands, created_at
         from import_batches order by id desc limit 25`);
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').slice(0, 200);
    const t0 = process.hrtime.bigint();
    const { rows } = await pool.query('select * from search_components($1, null, null, 25)', [q]);
    res.json({ ms: Number(process.hrtime.bigint() - t0) / 1e6, rows });
  } catch (e) { next(e); }
});

app.post('/api/imports', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded (field name "file")' });
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const allowNewBrands = req.query.allowNewBrands !== '0';
    let parsed;
    try {
      parsed = await parseFile(req.file.buffer, req.file.originalname);
    } catch (e) {
      return res.status(400).json({ error: `could not read ${req.file.originalname}: ${e.message}` });
    }
    if (!parsed.rows.length) return res.status(400).json({ error: 'file has no data rows' });
    const report = await importComponents(pool, parsed, {
      dryRun, allowNewBrands, filename: req.file.originalname, origin: 'admin',
    });
    res.json({ ...report, headers: parsed.headers });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `file larger than ${MAX_MB} MB` : err.message });
});

app.listen(PORT, () => console.log(`admin dashboard on http://localhost:${PORT}`));
