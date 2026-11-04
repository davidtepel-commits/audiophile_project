'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/normalize');
const { editDistance, isLikelyTypo } = require('../src/importer');
const { parseFile } = require('../src/parse');

test('normKey mirrors SQL audio_norm', () => {
  assert.equal(n.normKey('Bowers & Wilkins 702 S3'), 'bowers and wilkins 702 s3');
  assert.equal(n.normKey('  Morel  Octave-6 (Floor) '), 'morel octave 6 floor');
  assert.equal(n.normKey('Børresen'), 'borresen');
  assert.equal(n.normKey('Classé'), 'classe');
});

test('sensitivity parsing', () => {
  assert.equal(n.parseSensitivity('88 dB').value, 88);
  assert.equal(n.parseSensitivity('87dB/2.83V/1m').value, 87);
  assert.equal(n.parseSensitivity('87,5 dB').value, 87.5);
  assert.equal(n.parseSensitivity(91.5).value, 91.5);
  assert.equal(n.parseSensitivity('').value, null);
  assert.equal(n.parseSensitivity('n/a').value, null);
  assert.match(n.parseSensitivity('300 dB').error, /outside/);
});

test('impedance parsing', () => {
  assert.equal(n.parseImpedance('4 Ω').value, 4);
  assert.equal(n.parseImpedance('4 ohms').value, 4);
  assert.equal(n.parseImpedance('8 (min 3.2)').value, 8);
  const r = n.parseImpedance('4-8 Ω');
  assert.equal(r.value, 4);
  assert.match(r.warning, /range/);
});

test('RMS wattage parsing', () => {
  assert.equal(n.parseWatts('150W RMS').value, 150);
  assert.equal(n.parseWatts('100W RMS / 200W peak').value, 100);
  assert.equal(n.parseWatts('peak 400W, 200W continuous').value, 200);
  assert.equal(n.parseWatts('2 x 75W').value, 75);
  assert.equal(n.parseWatts('1.2kW').value, 1200);
  assert.equal(n.parseWatts('1,000 W').value, 1000);
});

test('category normalisation', () => {
  assert.equal(n.parseCategory('Tower'), 'floorstanding');
  assert.equal(n.parseCategory('Stand-mount'), 'bookshelf');
  assert.equal(n.parseCategory('Integrated amplifier'), 'integrated_amp');
  assert.equal(n.parseCategory('car subwoofer'), 'car_subwoofer');
  assert.equal(n.parseCategory('', 'Octave 6 Floorstanding'), 'floorstanding');
  assert.equal(n.parseCategory('floorstanding'), 'floorstanding');
});

test('header mapping handles vendor spellings and ignores peak/min columns', () => {
  const { map, unmapped, missing } = n.mapHeaders([
    'Manufacturer', 'Model Name', 'Speaker Type', 'Sensitivity (dB/2.83V/1m)', 'Nominal Impedance (Ω)', 'Peak Power', 'Power Handling RMS', 'Finish',
  ]);
  assert.deepEqual(missing, []);
  assert.equal(map['Manufacturer'], 'brand');
  assert.equal(map['Model Name'], 'model');
  assert.equal(map['Speaker Type'], 'category');
  assert.equal(map['Sensitivity (dB/2.83V/1m)'], 'sensitivity_db');
  assert.equal(map['Nominal Impedance (Ω)'], 'nominal_impedance_ohm');
  assert.equal(map['Power Handling RMS'], 'rms_watts');
  assert.ok(unmapped.includes('Peak Power'));
  assert.ok(unmapped.includes('Finish'));
});

test('normalizeRow keeps unmapped columns in specs and rejects missing brand', () => {
  const { map } = n.mapHeaders(['Brand', 'Model', 'Finish']);
  const ok = n.normalizeRow({ Brand: 'Morel', Model: 'Octave 6', Finish: 'Walnut' }, map);
  assert.equal(ok.record.specs.Finish, 'Walnut');
  const bad = n.normalizeRow({ Brand: '', Model: 'X', Finish: '' }, map);
  assert.equal(bad.record, null);
  assert.deepEqual(bad.errors, ['missing Brand']);
});

test('brand typo detection', () => {
  assert.equal(editDistance('dynaudoi', 'dynaudio'), 1);
  assert.ok(isLikelyTypo('Dynaudoi', 'Dynaudio', 0.5, 0.6));
  assert.ok(isLikelyTypo('Morrel', 'Morel', 0.62, 0.6));
  assert.ok(!isLikelyTypo('Brand New Acoustics', 'Neat Acoustics', 0.5, 0.6));
});

test('CSV parser: delimiter sniffing, comments and real line numbers', async () => {
  const csv = '# comment\nBrand;Model;Impedance\nKEF;R3 Meta;4\n\nFocal;Aria;8\n';
  const p = await parseFile(Buffer.from(csv), 'x.csv');
  assert.deepEqual(p.headers, ['Brand', 'Model', 'Impedance']);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.lines, [3, 5]);
});

test('JSON parser: wrapped arrays and nested spec objects', async () => {
  const j = { components: [{ brand: 'Morel', model: 'Octave 6', specs: { sensitivity: '88 dB', impedance: 4 } }] };
  const p = await parseFile(Buffer.from(JSON.stringify(j)), 'x.json');
  assert.equal(p.rows[0].sensitivity, '88 dB');
  assert.equal(p.rows[0].impedance, 4);
});
