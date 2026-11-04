'use strict';
/**
 * Header mapping + value parsing for messy spec dumps.
 * Shared by the ingestion CLI and the admin bulk uploader so both behave identically.
 */

/** JS twin of SQL public.audio_norm(). Keep in sync with 001_catalog_schema.sql. */
function normKey(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')    // strip accents (≈ unaccent)
    .replace(/ø/gi, 'o').replace(/æ/gi, 'ae').replace(/ß/g, 'ss').replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Column mapping. Keys are compared after headerKey(): lowercase, alnum only.
// ---------------------------------------------------------------------------
const headerKey = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const FIELD_ALIASES = {
  brand: ['brand', 'manufacturer', 'make', 'maker', 'brandname', 'mfr', 'mfg', 'vendor'],
  model: ['model', 'modelname', 'name', 'product', 'productname', 'modelnumber', 'sku', 'component'],
  category: ['category', 'type', 'producttype', 'class', 'kind', 'form', 'formfactor', 'speakertype'],
  sensitivity_db: ['sensitivity', 'sensitivitydb', 'sensitivitydbspl', 'spl', 'efficiency', 'sens', 'sensitivity283v1m', 'sensitivity1w1m'],
  nominal_impedance_ohm: ['nominalimpedance', 'impedance', 'impedanceohm', 'impedanceohms', 'nominalimpedanceohm', 'nominalimpedanceohms', 'ohms', 'ohm', 'imp', 'z'],
  rms_watts: ['rmswattage', 'rms', 'rmswatts', 'rmspower', 'wattsrms', 'rmsw', 'continuouspower', 'powerrms', 'powerhandlingrms', 'ratedpower', 'power', 'powerhandling', 'wattage', 'watts', 'outputpower'],
};

// Fallback substring rules for headers like "Sensitivity (dB/2.83V/1m)" or "Nominal Impedance (Ω)".
const FIELD_CONTAINS = [
  ['sensitivity_db', /sensitiv|efficien/],
  ['nominal_impedance_ohm', /impedan|ohm/],
  ['rms_watts', /rms|watt|continuous|power/],
  ['brand', /brand|manufactur/],
  ['model', /model/],
  ['category', /category|type/],
];

/**
 * @param {string[]} headers raw header row
 * @returns {{ map: Record<string,string>, unmapped: string[], missing: string[] }}
 *   map: rawHeader -> canonical field
 */
function mapHeaders(headers) {
  const map = {};
  const taken = new Set();
  const lookup = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) for (const a of aliases) lookup[a] = field;

  // pass 1: exact alias
  for (const h of headers) {
    const f = lookup[headerKey(h)];
    if (f && !taken.has(f)) { map[h] = f; taken.add(f); }
  }
  // pass 2: substring rules for whatever is still unmapped
  for (const h of headers) {
    if (map[h]) continue;
    const k = headerKey(h);
    if (/^(min|max|peak|music|recommended)/.test(k) && !/rms/.test(k)) continue; // "Peak Power", "Min Impedance" are not our fields
    for (const [field, re] of FIELD_CONTAINS) {
      if (!taken.has(field) && re.test(k)) { map[h] = field; taken.add(field); break; }
    }
  }
  const unmapped = headers.filter((h) => !map[h] && String(h).trim() !== '');
  const missing = ['brand', 'model'].filter((f) => !taken.has(f));
  return { map, unmapped, missing };
}

// ---------------------------------------------------------------------------
// Value parsers. Each returns { value, warning? }. value null = blank/unparseable.
// ---------------------------------------------------------------------------
function toNumberish(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s || /^(n\/?a|-|—|tbd|unknown|\?)$/i.test(s)) return null;
  // European decimal comma: "87,5 dB" (but not thousands "1,000")
  s = s.replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2').replace(/(\d),(\d{3})/g, '$1$2');
  return s;
}

function firstNumber(s) {
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function parseSensitivity(raw) {
  const s = toNumberish(raw);
  if (s == null) return { value: null };
  if (typeof s === 'number') return range(s, 50, 130, 'sensitivity');
  return range(firstNumber(s), 50, 130, 'sensitivity', raw);
}

function parseImpedance(raw) {
  const s = toNumberish(raw);
  if (s == null) return { value: null };
  if (typeof s === 'number') return range(s, 0.5, 600, 'impedance');
  // "4-8 ohm" / "4/8" -> 4 (lowest nominal is the one amps care about), "8 (min 3.2)" -> 8
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|\/|to)\s*(\d+(?:\.\d+)?)/);
  if (m) {
    const r = range(Math.min(parseFloat(m[1]), parseFloat(m[2])), 0.5, 600, 'impedance', raw);
    return { ...r, warning: r.warning || `impedance range "${raw}" stored as ${r.value}Ω` };
  }
  return range(firstNumber(s), 0.5, 600, 'impedance', raw);
}

function parseWatts(raw) {
  const s = toNumberish(raw);
  if (s == null) return { value: null };
  if (typeof s === 'number') return range(s, 0, 100000, 'RMS wattage');
  let str = s.toLowerCase();
  // "2 x 100W" / "2x100" -> per channel 100
  const multi = str.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)/);
  if (multi) return range(parseFloat(multi[2]), 0, 100000, 'RMS wattage', raw);
  // "1.2kW"
  const kw = str.match(/(\d+(?:\.\d+)?)\s*kw/);
  if (kw) return range(parseFloat(kw[1]) * 1000, 0, 100000, 'RMS wattage', raw);
  // "150W RMS / 300W peak" -> take the number next to "rms" if present
  const rms = str.match(/(\d+(?:\.\d+)?)\s*w?\s*(?:rms|continuous)/) || str.match(/(?:rms|continuous)\D{0,6}(\d+(?:\.\d+)?)/);
  if (rms) return range(parseFloat(rms[1]), 0, 100000, 'RMS wattage', raw);
  return range(firstNumber(str), 0, 100000, 'RMS wattage', raw);
}

function range(v, lo, hi, label, raw) {
  if (v == null || Number.isNaN(v)) return { value: null, warning: raw != null ? `could not parse ${label} "${raw}"` : undefined };
  if (v < lo || v > hi) return { value: null, error: `${label} ${v} outside ${lo}–${hi}` };
  return { value: Math.round(v * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Category normalisation -> values allowed by components_category_chk
// ---------------------------------------------------------------------------
const CATEGORY_RULES = [
  [/car.*sub|sub.*car/, 'car_subwoofer'],
  [/car.*amp|amp.*car|mono\s*block.*car/, 'car_amp'],
  [/coax/, 'car_coaxial'],
  [/component\s*(set|system|speaker)|car.*speaker|2-?way\s*component|3-?way\s*component/, 'car_component'],
  [/floor|tower|column/, 'floorstanding'],
  [/book\s*-?shel|stand\s*-?mount|standmount|monitor\b|compact|satellite/, 'bookshelf'],
  [/cent(er|re)/, 'center'],
  [/sub/, 'subwoofer'],
  [/in-?\s*wall|in-?\s*ceiling|architectural/, 'in_wall'],
  [/on-?\s*wall/, 'on_wall'],
  [/sound\s*bar/, 'soundbar'],
  [/\biem\b|in-?ear/, 'iem'],
  [/head\s*phone\s*amp|headamp/, 'headphone_amp'],
  [/head\s*phone|over-?ear|on-?ear/, 'headphones'],
  [/phono/, 'phono_stage'],
  [/integrated/, 'integrated_amp'],
  [/power\s*amp|mono\s*block|monoblock|stereo\s*amp/, 'power_amp'],
  [/pre\s*-?amp|preamplifier/, 'preamp'],
  [/receiver|avr\b/, 'receiver'],
  [/\bdac\b|converter/, 'dac'],
  [/stream|network\s*player/, 'streamer'],
  [/\bcd\b|sacd/, 'cd_player'],
  [/turntable|record\s*player/, 'turntable'],
  [/cartridge|\bmc\b|\bmm\b/, 'cartridge'],
  [/woofer|tweeter|mid\s*range|driver|full\s*range/, 'driver'],
  [/cable|interconnect/, 'cable'],
  [/\bamp/, 'integrated_amp'],
];

function parseCategory(raw, modelHint = '') {
  const src = `${raw || ''}`.toLowerCase().trim();
  if (src) {
    const direct = src.replace(/[\s-]+/g, '_');
    if (ALLOWED_CATEGORIES.has(direct)) return direct;
    for (const [re, cat] of CATEGORY_RULES) if (re.test(src)) return cat;
  }
  // fall back to words in the model name ("Octave 6 Floorstanding")
  const m = String(modelHint).toLowerCase();
  for (const [re, cat] of CATEGORY_RULES.slice(4, 8)) if (re.test(m)) return cat;
  return 'other';
}

const ALLOWED_CATEGORIES = new Set([
  'floorstanding', 'bookshelf', 'center', 'subwoofer', 'in_wall', 'on_wall', 'soundbar',
  'headphones', 'iem', 'integrated_amp', 'power_amp', 'preamp', 'receiver', 'phono_stage', 'headphone_amp',
  'dac', 'streamer', 'cd_player', 'turntable', 'cartridge',
  'car_component', 'car_coaxial', 'car_subwoofer', 'car_amp', 'driver', 'cable', 'other',
]);

/**
 * Turn one raw spreadsheet/JSON row into a canonical component record.
 * @returns {{ record: object|null, errors: string[], warnings: string[] }}
 */
function normalizeRow(raw, headerMap) {
  const errors = [];
  const warnings = [];
  const out = { specs: {} };

  for (const [header, value] of Object.entries(raw)) {
    const field = headerMap[header];
    if (field) out[field] = value;
    else if (value !== '' && value != null && String(header).trim() !== '') out.specs[String(header).trim()] = value;
  }

  const brand = String(out.brand ?? '').trim();
  const model = String(out.model ?? '').trim().replace(/\s+/g, ' ');
  if (!brand) errors.push('missing Brand');
  if (!model) errors.push('missing Model');

  const sens = parseSensitivity(out.sensitivity_db);
  const imp = parseImpedance(out.nominal_impedance_ohm);
  const rms = parseWatts(out.rms_watts);
  for (const r of [sens, imp, rms]) { if (r.error) errors.push(r.error); if (r.warning) warnings.push(r.warning); }

  // keep the original strings so nothing from the vendor sheet is lost
  for (const [k, v] of [['sensitivity_raw', out.sensitivity_db], ['impedance_raw', out.nominal_impedance_ohm], ['rms_raw', out.rms_watts]]) {
    if (v != null && v !== '' && typeof v !== 'number') out.specs[k] = String(v);
  }

  if (errors.length) return { record: null, errors, warnings };
  return {
    record: {
      brand,
      model,
      category: parseCategory(out.category, model),
      sensitivity_db: sens.value,
      nominal_impedance_ohm: imp.value,
      rms_watts: rms.value,
      specs: out.specs,
    },
    errors,
    warnings,
  };
}

module.exports = {
  normKey, mapHeaders, normalizeRow,
  parseSensitivity, parseImpedance, parseWatts, parseCategory,
  ALLOWED_CATEGORIES,
};
