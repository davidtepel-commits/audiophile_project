'use strict';
/**
 * Runs against a real database. Skipped unless TEST_DATABASE_URL is set.
 * DESTRUCTIVE to the catalog tables in that DB - point it at a scratch database.
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/audiophile_test npm run test:db
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { upsertBrands, importComponents } = require('../src/importer');
const { parseFile } = require('../src/parse');

const url = process.env.TEST_DATABASE_URL;
const opts = { skip: !url && 'TEST_DATABASE_URL not set' };

test('catalog end-to-end', opts, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());
  for (const f of fs.readdirSync(path.join(__dirname, '../db/migrations')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '../db/migrations', f), 'utf8'));
  }
  await pool.query('truncate components, brand_aliases, brands, import_batches restart identity cascade');

  const { brands } = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/brands.json'), 'utf8'));
  const c = await pool.connect();
  await upsertBrands(c, brands);
  c.release();

  const parsed = await parseFile(fs.readFileSync(path.join(__dirname, 'fixtures/spec_dump.csv')), 'spec_dump.csv');

  await t.test('dry run writes nothing', async () => {
    const r = await importComponents(pool, parsed, { dryRun: true });
    assert.equal(r.inserted, 14);
    const { rows } = await pool.query('select count(*)::int n from components');
    assert.equal(rows[0].n, 0);
  });

  await t.test('commit, then re-import is all updates', async () => {
    const r1 = await importComponents(pool, parsed, { filename: 'a.csv' });
    assert.equal(r1.inserted, 14);
    assert.equal(r1.rejected, 1);
    assert.equal(r1.unknownBrands[0].action, 'mapped to Morel');   // "Morrel" typo
    assert.deepEqual(r1.newBrands, []);
    const r2 = await importComponents(pool, parsed, { filename: 'b.csv' });
    assert.equal(r2.inserted, 0);
    assert.equal(r2.updated, 14);
  });

  await t.test('blank cells do not overwrite stored specs', async () => {
    const p = await parseFile(Buffer.from('Brand,Model,Sensitivity\nKEF,R7 Meta,\n'), 'x.csv');
    await importComponents(pool, p, {});
    const { rows } = await pool.query(`select sensitivity_db::float s from components where model = 'R7 Meta'`);
    assert.equal(rows[0].s, 87.5);
  });

  await t.test('fuzzy search: "Morel Octav" -> 4-ohm floorstanders only', async () => {
    const { rows } = await pool.query(`select model, nominal_impedance_ohm::float z, category from search_components('Morel Octav 4 ohm floorstanding')`);
    assert.deepEqual(rows.map((r) => r.model).sort(), ['Octave 6 Floorstanding', 'Octave 8 Floorstanding']);
    assert.ok(rows.every((r) => r.z === 4 && r.category === 'floorstanding'));
  });

  await t.test('fuzzy search: explicit params, typos, aliases, misses', async () => {
    let r = await pool.query(`select model from search_components('morel octav', p_impedance => 4, p_category => 'floorstanding')`);
    assert.equal(r.rowCount, 2);
    r = await pool.query(`select model from search_components('morell octave')`);
    assert.ok(r.rowCount >= 6);
    r = await pool.query(`select brand from search_components('b&w 705')`);
    assert.equal(r.rows[0].brand, 'Bowers & Wilkins');
    r = await pool.query(`select 1 from search_components('Sonus Faber Olympica')`);
    assert.equal(r.rowCount, 0);
  });

  await t.test('unknown brands rejected when new brands are disallowed', async () => {
    const p = await parseFile(Buffer.from('Brand,Model\nTotally Unknown Co,Z1\n'), 'x.csv');
    const r = await importComponents(pool, p, { allowNewBrands: false });
    assert.equal(r.rejected, 1);
    assert.equal(r.inserted, 0);
  });
});
