'use strict';
/** Read CSV / TSV / JSON / NDJSON / XLSX buffers into { headers, rows } (rows = array of objects). */
const { parse: parseCsv } = require('csv-parse/sync');

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() && !l.trimStart().startsWith('#')) || '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

function fromCsv(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const records = parseCsv(text, {
    delimiter,
    columns: (hdr) => hdr.map((h, i) => (String(h).trim() || `column_${i + 1}`)),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    comment: '#',
    comment_no_infix: true,
    bom: true,
    info: true,
  });
  const rows = records.map((r) => r.record);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  // physical line numbers so error messages point at the right spreadsheet row
  return { headers, rows, lines: records.map((r) => r.info.lines) };
}

function fromJson(buf) {
  const text = buf.toString('utf8').replace(/^﻿/, '').trim();
  let data;
  if (text.startsWith('[') || text.startsWith('{')) {
    try { data = JSON.parse(text); } catch (e) { data = undefined; if (!text.includes('\n')) throw e; }
  }
  if (data === undefined) data = text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); // NDJSON
  if (!Array.isArray(data)) {
    data = data.components || data.items || data.data || data.rows || data.products || [];
  }
  // Flatten one level of nesting: { specs: { sensitivity: 87 } } -> { sensitivity: 87 }
  const rows = data.map((r) => {
    const flat = {};
    for (const [k, v] of Object.entries(r || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(flat, v);
      else flat[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    return flat;
  });
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { headers, rows };
}

async function fromXlsx(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets.find((s) => s.actualRowCount > 1) || wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const cellVal = (c) => {
    const v = c.value;
    if (v == null) return '';
    if (typeof v === 'object') {
      if ('result' in v) return v.result ?? '';          // formula
      if ('richText' in v) return v.richText.map((t) => t.text).join('');
      if ('text' in v) return v.text;                     // hyperlink
      if (v instanceof Date) return v.toISOString();
    }
    return v;
  };
  const headerRow = ws.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(cellVal(c)).trim() || `column_${i}`; });
  const rows = [];
  const lines = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj = {}; let any = false;
    headers.forEach((h, i) => { const v = cellVal(row.getCell(i + 1)); obj[h] = typeof v === 'string' ? v.trim() : v; if (v !== '') any = true; });
    if (any) { rows.push(obj); lines.push(n); }
  });
  return { headers, rows, lines };
}

/** @param {Buffer} buf @param {string} filename */
async function parseFile(buf, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xlsm') return fromXlsx(buf);
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl') return fromJson(buf);
  if (ext === 'xls') throw new Error('Legacy .xls is not supported - save as .xlsx or .csv');
  // sniff content when the extension is unhelpful
  if (buf[0] === 0x50 && buf[1] === 0x4b) return fromXlsx(buf);         // "PK" zip -> xlsx
  const head = buf.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return fromJson(buf);
  return fromCsv(buf);
}

module.exports = { parseFile, detectDelimiter };
