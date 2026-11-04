#!/usr/bin/env node
'use strict';
/** Applies db/migrations/*.sql in order, once each (tracked in schema_migrations). */
const fs = require('fs');
const path = require('path');
const { createPool } = require('../src/db');

(async () => {
  const pool = createPool();
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const force = process.argv.includes('--reapply'); // re-run all (every file is idempotent)
  try {
    await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await pool.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f) && !force) { console.log(`  skip  ${f}`); continue; }
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1) on conflict do nothing', [f]);
        await client.query('commit');
        console.log(`  apply ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`${f}: ${e.message}`);
      } finally { client.release(); }
    }
  } finally { await pool.end(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
