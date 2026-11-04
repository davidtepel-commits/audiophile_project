// Compiles brands.src.tsv (easy to hand-edit) into brands.json (what the ingester reads).
const fs = require('fs'); const path = require('path');
const rows = fs.readFileSync(path.join(__dirname, 'brands.src.tsv'), 'utf8').split('\n')
  .filter(l => l.trim() && !l.startsWith('#'))
  .map(l => { const [name, country, cats = '', aliases = ''] = l.split('\t');
    return { name: name.trim(), country: country.trim() || null,
      categories: cats.split(',').map(s => s.trim()).filter(Boolean),
      aliases: aliases.split('|').map(s => s.trim()).filter(Boolean) }; });
const seen = new Set();
for (const r of rows) { const k = r.name.toLowerCase(); if (seen.has(k)) throw new Error('dup ' + r.name); seen.add(k); }
fs.writeFileSync(path.join(__dirname, 'brands.json'), JSON.stringify({ version: 1, brands: rows }, null, 1) + '\n');
console.log(`wrote ${rows.length} brands`);
