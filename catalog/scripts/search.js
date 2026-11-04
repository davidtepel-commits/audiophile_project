#!/usr/bin/env node
'use strict';
/** Quick CLI check of the local fuzzy search:  node scripts/search.js "Morel Octav 4 ohm floorstanding" */
const { createPool } = require('../src/db');

(async () => {
  const q = process.argv.slice(2).join(' ');
  if (!q) { console.error('usage: search.js <query>'); process.exit(1); }
  const pool = createPool();
  const t0 = process.hrtime.bigint();
  const { rows } = await pool.query('select * from search_components($1)', [q]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.table(rows.map((r) => ({ brand: r.brand, model: r.model, category: r.category, 'Ω': r.nominal_impedance_ohm, dB: r.sensitivity_db, 'W rms': r.rms_watts, score: r.score.toFixed(2) })));
  console.log(`${rows.length} result(s) in ${ms.toFixed(1)} ms${rows.length ? '' : ' -> app should fall back to the LLM lookup'}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
