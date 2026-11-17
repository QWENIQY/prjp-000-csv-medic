'use strict';

/**
 * CSV Medic — Shopify product CSV fixing engine.
 *
 * fixShopifyCsv({ headers, rows }) -> { headers, rows, issues, summary }
 *
 * Pure and deterministic (no I/O), and idempotent: running it on its own
 * output produces no further "fixed" changes. Used on upload, on re-check
 * from the editor, and again server-side before export.
 */

// Shopify's product CSV columns (classic template, still accepted by Shopify import).
const CANONICAL = [
  'Handle', 'Title', 'Body (HTML)', 'Vendor', 'Product Category', 'Type', 'Tags', 'Published',
  'Option1 Name', 'Option1 Value', 'Option1 Linked To',
  'Option2 Name', 'Option2 Value', 'Option2 Linked To',
  'Option3 Name', 'Option3 Value', 'Option3 Linked To',
  'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty',
  'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price',
  'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode',
  'Image Src', 'Image Position', 'Image Alt Text', 'Gift Card', 'SEO Title', 'SEO Description',
  'Variant Image', 'Variant Weight Unit', 'Variant Tax Code', 'Cost per item', 'Status',
];

const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Common alternative / misspelt / new-template header names -> canonical name.
const ALIASES = (() => {
  const m = new Map();
  for (const c of CANONICAL) m.set(key(c), c);
  const add = (canon, ...names) => names.forEach((n) => m.set(key(n), canon));
  add('Handle', 'URL handle', 'product handle', 'slug', 'url slug', 'handles');
  add('Title', 'name', 'product name', 'product title', 'title name');
  add('Body (HTML)', 'body', 'body html', 'description', 'product description', 'description html', 'html description', 'body_html');
  add('Vendor', 'brand', 'manufacturer', 'supplier');
  add('Product Category', 'category', 'google product category', 'product_category');
  add('Type', 'product type', 'product_type');
  add('Tags', 'tag', 'keywords', 'product tags');
  add('Published', 'published on online store', 'published on store', 'visible', 'is published', 'online store');
  add('Variant SKU', 'sku', 'product sku', 'item sku');
  add('Variant Grams', 'weight value (grams)', 'weight value', 'grams', 'weight grams', 'weight (grams)', 'weight in grams', 'variant weight grams');
  add('Variant Inventory Tracker', 'inventory tracker', 'track inventory', 'track quantity');
  add('Variant Inventory Qty', 'inventory qty', 'inventory quantity', 'quantity', 'qty', 'stock', 'stock qty', 'stock quantity', 'inventory', 'variant inventory quantity');
  add('Variant Inventory Policy', 'inventory policy', 'continue selling when out of stock', 'continue selling');
  add('Variant Fulfillment Service', 'fulfillment service', 'fulfilment service', 'variant fulfilment service');
  add('Variant Price', 'price', 'product price', 'sale price', 'selling price', 'retail price');
  add('Variant Compare At Price', 'compare at price', 'compare-at price', 'compare price', 'rrp', 'msrp', 'was price', 'original price', 'regular price');
  add('Variant Requires Shipping', 'requires shipping', 'physical product', 'shipping required');
  add('Variant Taxable', 'taxable', 'charge tax', 'charge tax on this product');
  add('Variant Barcode', 'barcodes', 'barcode', 'upc', 'ean', 'gtin', 'isbn', 'barcode (isbn, upc, gtin, etc.)');
  add('Image Src', 'image', 'image url', 'image link', 'product image', 'product image url', 'image source', 'images', 'main image');
  add('Image Position', 'image order', 'image index');
  add('Image Alt Text', 'alt text', 'image alt', 'alt');
  add('Gift Card', 'is gift card', 'giftcard');
  add('SEO Title', 'meta title', 'page title', 'seo_title');
  add('SEO Description', 'meta description', 'seo_description');
  add('Variant Image', 'variant image url', 'variant image src');
  add('Variant Weight Unit', 'weight unit for display', 'weight unit', 'unit of weight', 'weight unit for variant', 'variant weight unit');
  add('Variant Tax Code', 'tax code');
  add('Cost per item', 'cost', 'unit cost', 'item cost', 'cost price', 'variant cost');
  add('Status', 'product status', 'state');
  for (const i of [1, 2, 3]) {
    add(`Option${i} Name`, `option ${i} name`, `option${i}name`, `option${i}`);
    add(`Option${i} Value`, `option ${i} value`, `option${i}value`, `option ${i} values`);
    add(`Option${i} Linked To`, `option ${i} linked to`);
  }
  return m;
})();

const PRICE_COLS = ['Variant Price', 'Variant Compare At Price', 'Cost per item'];
const BOOL_COLS = ['Published', 'Variant Requires Shipping', 'Variant Taxable', 'Gift Card'];
const IMAGE_COLS = ['Image Src', 'Variant Image'];
const VARIANT_COLS = [
  'Option1 Value', 'Option2 Value', 'Option3 Value', 'Variant SKU', 'Variant Price', 'Variant Grams',
  'Variant Inventory Qty', 'Variant Barcode', 'Variant Compare At Price',
];

const MAX_DETAILED_ISSUES = 5000;

/* ------------------------------------------------------------------ */
/* Text-level helpers                                                  */
/* ------------------------------------------------------------------ */

// Windows-1252 code points for bytes 0x80–0x9F (used to reverse "mojibake").
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const MOJIBAKE_HINT = /[ÂÃâÅÆÐÑ][\u0080-¿Œ-ƒˆ˜–-™]/;
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/** Repair UTF-8 text that was mis-decoded as Windows-1252 (e.g. "Ã©" -> "é", "â€™" -> "’"). */
function fixMojibake(s) {
  if (!MOJIBAKE_HINT.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x100) bytes[n++] = c;
    else if (CP1252[c] !== undefined) bytes[n++] = CP1252[c];
    else return s; // contains characters that can't be mojibake — leave alone
  }
  try {
    return utf8Fatal.decode(bytes.subarray(0, n));
  } catch {
    return s;
  }
}

// Zero-width chars, BOMs, and control characters (keeping \t \n \r).
const INVISIBLE = /[​-‍⁠﻿\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’"]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

/** Parse a human-entered price ("£1,299.00", "12,99 €", "USD 5") into "1299.00". Returns null if unparseable. */
function parsePrice(raw) {
  let s = String(raw).trim();
  if (s === '') return '';
  s = s.replace(/^(gbp|usd|eur|aud|cad|nzd|chf|sek|nok|dkk|jpy|inr)\s*/i, '').replace(/\s*(gbp|usd|eur|aud|cad|nzd|chf|sek|nok|dkk|jpy|inr)$/i, '');
  s = s.replace(/[£$€¥₹\s ']/g, '').replace(/^(a|c|nz|us)(?=\d)/i, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever separator comes last is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    // "12,99" -> decimal comma; "1,299" / "1,299,000" -> thousands
    if (parts.length === 2 && parts[1].length !== 3) s = parts.join('.');
    else s = parts.join('');
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, ''); // "1.299.000" thousands dots
  }
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return { value: neg ? -v : v, text: (neg ? -v : v).toFixed(2) };
}

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '1', 'on', 'published', 'visible', 'active', 'enabled']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '0', 'off', 'unpublished', 'hidden', 'draft', 'disabled']);

function parseBool(raw) {
  const s = String(raw).trim();
  if (/^(true|false)$/i.test(s)) return s; // already valid — Shopify accepts any case
  const v = s.toLowerCase();
  if (TRUE_WORDS.has(v)) return 'true';
  if (FALSE_WORDS.has(v)) return 'false';
  return null;
}

function parseInteger(raw, { allowNegative = true } = {}) {
  let s = String(raw).trim().replace(/[,\s]/g, '');
  if (s === '') return '';
  if (/^-?\d+(\.0+)?$/.test(s)) s = s.replace(/\.0+$/, '');
  else if (/^-?\d*\.\d+$/.test(s)) s = String(Math.round(Number(s)));
  else return null;
  const v = Number(s);
  if (!Number.isFinite(v) || (!allowNegative && v < 0)) return null;
  return String(v);
}

const WEIGHT_UNITS = new Map([
  ['g', 'g'], ['gr', 'g'], ['gram', 'g'], ['grams', 'g'], ['gramme', 'g'], ['grammes', 'g'],
  ['kg', 'kg'], ['kgs', 'kg'], ['kilo', 'kg'], ['kilos', 'kg'], ['kilogram', 'kg'], ['kilograms', 'kg'],
  ['lb', 'lb'], ['lbs', 'lb'], ['pound', 'lb'], ['pounds', 'lb'],
  ['oz', 'oz'], ['ounce', 'oz'], ['ounces', 'oz'],
]);

const STATUS = new Map([
  ['active', 'active'], ['live', 'active'], ['published', 'active'], ['enabled', 'active'], ['on', 'active'], ['true', 'active'],
  ['draft', 'draft'], ['hidden', 'draft'], ['unpublished', 'draft'], ['disabled', 'draft'], ['off', 'draft'], ['false', 'draft'], ['pending', 'draft'],
  ['archived', 'archived'], ['archive', 'archived'], ['deleted', 'archived'], ['discontinued', 'archived'],
]);

/** Clean an image URL. Returns { url, note } or { error }. */
function fixImageUrl(raw) {
  let s = String(raw).trim();
  if (s === '') return { url: '' };
  let note = null;
  if (s.startsWith('//')) { s = 'https:' + s; note = 'Added https: to protocol-relative URL'; }
  else if (/^www\./i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\/\S/i.test(s)) { s = 'https://' + s; note = 'Added https:// to URL'; }
  if (!/^https?:\/\//i.test(s)) return { error: 'Image URL must start with http:// or https:// — Shopify downloads images from the web, it cannot use a file on your computer.' };

  const drive = s.match(/^https?:\/\/drive\.google\.com\/(?:file\/d\/([\w-]+)|open\?id=([\w-]+))/i);
  if (drive) {
    s = `https://drive.google.com/uc?export=download&id=${drive[1] || drive[2]}`;
    note = 'Converted Google Drive share link to a direct image link';
  }
  if (/^https?:\/\/(www\.)?dropbox\.com\//i.test(s) && /[?&]dl=0\b/.test(s)) {
    s = s.replace(/([?&])dl=0\b/, '$1raw=1');
    note = 'Converted Dropbox share link to a direct image link';
  }
  if (/\s/.test(s)) {
    s = s.replace(/\s/g, '%20');
    note = note || 'Encoded spaces in image URL';
  }
  try {
    new URL(s);
  } catch {
    return { error: 'Image URL is not a valid web address.' };
  }
  return { url: s, note };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function fixShopifyCsv({ headers: rawHeaders, rows: rawRows, preNotes = [] }) {
  const issues = [];
  const counts = { fixed: 0, warning: 0, error: 0 };
  const byCode = {};

  const report = (severity, code, message, row = null, col = null, before, after) => {
    counts[severity]++;
    byCode[code] = byCode[code] || { code, severity, message: summaryMessage(code, message), count: 0 };
    byCode[code].count++;
    if (issues.length < MAX_DETAILED_ISSUES) {
      const issue = { severity, code, message, row, col };
      if (before !== undefined) issue.before = truncate(before);
      if (after !== undefined) issue.after = truncate(after);
      issues.push(issue);
    }
  };

  for (const note of preNotes) report('fixed', 'encoding', note);

  /* ---------- 1. Headers ---------- */
  let headers = rawHeaders.map((h) => String(h ?? ''));
  let rows = rawRows.map((r) => r.map((c) => (c == null ? '' : String(c))));
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);

  // Ragged rows: pad short rows, add columns for long ones.
  let extraCols = 0;
  while (headers.length < width) headers.push('');
  rows.forEach((r, i) => {
    if (r.length < width) {
      const missing = width - r.length;
      const hadContent = r.some((c) => c.trim() !== '');
      for (let k = 0; k < missing; k++) r.push('');
      if (hadContent && missing < width) {
        // Only worth mentioning if the row isn't a fully blank line
        report('fixed', 'ragged_row', `Row had ${missing} missing cell(s) — padded so columns line up.`, i);
      }
    }
  });

  // Drop columns that have no header and no data; name the rest.
  const keepCol = headers.map((h, ci) => h.trim() !== '' || rows.some((r) => (r[ci] || '').trim() !== ''));
  if (keepCol.some((k) => !k)) {
    const dropped = keepCol.filter((k) => !k).length;
    headers = headers.filter((_, ci) => keepCol[ci]);
    rows = rows.map((r) => r.filter((_, ci) => keepCol[ci]));
    report('fixed', 'empty_column', `Removed ${dropped} completely empty column(s) with no header.`);
  }

  const seen = new Map();
  headers = headers.map((h, ci) => {
    let clean = fixMojibake(h.replace(INVISIBLE, '')).replace(/\s+/g, ' ').trim();
    if (clean === '') {
      extraCols++;
      const name = `Unnamed column ${extraCols}`;
      report('warning', 'unnamed_column', `Column ${ci + 1} had data but no header — named it "${name}". Shopify ignores columns it doesn't recognise.`, null, name);
      clean = name;
    }
    const canon = ALIASES.get(key(clean)) || (clean.toLowerCase().startsWith('product.metafields') || clean.toLowerCase().startsWith('variant.metafields') ? clean : null);
    let finalName = canon || clean;
    if (seen.has(finalName)) {
      report('warning', 'duplicate_column', `Column "${clean}" duplicates "${finalName}" (column ${seen.get(finalName) + 1}). Kept the first; renamed this one so it is ignored — check which one you meant.`, null, clean);
      finalName = `${clean} (duplicate)`;
    } else if (finalName !== h) {
      report('fixed', 'header_renamed', `Renamed column "${h}" to Shopify's "${finalName}".`, null, finalName, h, finalName);
    }
    seen.set(finalName, ci);
    return finalName;
  });

  const col = Object.fromEntries(headers.map((h, i) => [h, i]));
  const has = (name) => col[name] !== undefined;

  // Shopify's minimum: a Handle column (we can create it) and a Title column.
  if (!has('Handle')) {
    headers.unshift('Handle');
    rows.forEach((r) => r.unshift(''));
    for (const k of Object.keys(col)) col[k]++;
    col.Handle = 0;
    report('fixed', 'added_handle_column', 'Added the required "Handle" column (generated from product titles).');
  }
  if (!has('Title')) {
    report('error', 'missing_title_column', 'No "Title" column found. Shopify needs a Title for every new product.');
  }

  /* ---------- 2. Cell-level text cleanup ---------- */
  const isBody = (ci) => headers[ci] === 'Body (HTML)';
  let removedBlank = 0;
  rows = rows.filter((r) => {
    const blank = r.every((c) => c.replace(INVISIBLE, '').trim() === '');
    if (blank) removedBlank++;
    return !blank;
  });
  if (removedBlank) report('fixed', 'blank_rows', `Removed ${removedBlank} empty row(s).`);

  const seenRows = new Set();
  rows = rows.filter((r, ri) => {
    const sig = JSON.stringify(r.map((c) => c.trim()));
    if (seenRows.has(sig)) {
      report('fixed', 'duplicate_row', 'Removed a row that was an exact duplicate of an earlier row.', ri);
      return false;
    }
    seenRows.add(sig);
    return true;
  });

  rows.forEach((r, ri) => {
    for (let ci = 0; ci < r.length; ci++) {
      const before = r[ci];
      if (before === '') continue;
      let v = before.replace(INVISIBLE, '');
      const demoji = fixMojibake(v);
      if (demoji !== v) {
        report('fixed', 'mojibake', 'Repaired garbled characters (encoding damage, e.g. "Ã©" → "é", "â€™" → "’").', ri, headers[ci], v, demoji);
        v = demoji;
      }
      if (!isBody(ci)) {
        v = v.replace(/ /g, ' ').replace(/[\r\n]+/g, ' ').trim();
        if (headers[ci] !== 'Tags' && headers[ci] !== 'Image Alt Text') v = v.replace(/ {2,}/g, ' ');
      } else {
        v = v.trim();
      }
      const mojibakeFixed = demoji !== before.replace(INVISIBLE, '');
      if (v !== before && !mojibakeFixed) {
        report('fixed', 'whitespace', 'Cleaned stray spaces, line breaks or invisible characters.', ri, headers[ci], before, v);
      }
      r[ci] = v;
    }
  });

  const get = (r, name) => (has(name) ? r[col[name]] : '');
  const set = (r, ri, name, value, severity, code, message) => {
    if (!has(name)) return;
    const before = r[col[name]];
    if (before === value) return;
    r[col[name]] = value;
    report(severity || 'fixed', code, message, ri, name, before, value);
  };

  /* ---------- 3. Handles ---------- */
  const titleOf = (r) => get(r, 'Title');
  const hasVariantData = (r) => VARIANT_COLS.some((c) => get(r, c) !== '');
  let prevHandle = '';
  rows.forEach((r, ri) => {
    let h = get(r, 'Handle');
    if (h === '') {
      if (titleOf(r) !== '') {
        const generated = slugify(titleOf(r));
        // If the previous row is the same product (same title), keep it grouped.
        set(r, ri, 'Handle', generated, 'fixed', 'handle_generated', 'Generated missing Handle from the product Title.');
      } else if (prevHandle && (hasVariantData(r) || get(r, 'Image Src') !== '')) {
        set(r, ri, 'Handle', prevHandle, 'fixed', 'handle_inherited', 'Missing Handle on a variant/image row — copied from the product above.');
      } else {
        report('error', 'handle_missing', 'Row has no Handle and no Title, so Shopify cannot tell which product it belongs to.', ri, 'Handle');
      }
      h = get(r, 'Handle');
    }
    if (h !== '') {
      const clean = slugify(h);
      if (clean === '') {
        report('error', 'handle_invalid', 'Handle contains no letters or numbers.', ri, 'Handle');
      } else if (clean !== h) {
        set(r, ri, 'Handle', clean, 'fixed', 'handle_format', 'Handle reformatted: lowercase letters, numbers and hyphens only.');
      }
      prevHandle = get(r, 'Handle');
    }
  });

  /* ---------- 4. Group rows into products ---------- */
  const groups = new Map(); // handle -> array of row indexes
  const blocks = new Map(); // handle -> number of separate contiguous blocks
  rows.forEach((r, ri) => {
    const h = get(r, 'Handle');
    if (!h) return;
    if (!groups.has(h)) { groups.set(h, []); blocks.set(h, 1); }
    else {
      const g = groups.get(h);
      if (g[g.length - 1] !== ri - 1) blocks.set(h, blocks.get(h) + 1);
    }
    groups.get(h).push(ri);
  });

  for (const [handle, idxs] of groups) {
    const titles = new Set(idxs.map((i) => titleOf(rows[i])).filter(Boolean));
    if (titles.size > 1) {
      report('warning', 'handle_conflict', `Handle "${handle}" is shared by products with different titles (${[...titles].slice(0, 3).map((t) => `"${truncate(t, 40)}"`).join(', ')}). Shopify will merge them into one product — give each product its own Handle if they are different.`, idxs[1], 'Handle');
    } else if (blocks.get(handle) > 1) {
      report('warning', 'handle_split', `Rows for "${handle}" are not next to each other. Shopify still groups them, but keeping a product's rows together avoids mistakes.`, idxs[0], 'Handle');
    }

    const first = rows[idxs[0]];
    if (has('Title') && titleOf(first) === '') {
      const later = idxs.find((i) => titleOf(rows[i]) !== '');
      if (later !== undefined) {
        set(first, idxs[0], 'Title', titleOf(rows[later]), 'fixed', 'title_moved', 'Title must be on the first row of a product — copied it from a later row.');
      } else {
        report('warning', 'title_missing', `Product "${handle}" has no Title. That's fine when updating an existing product, but new products need one.`, idxs[0], 'Title');
      }
    }

    // Options
    const variantRows = idxs.filter((i) => hasVariantData(rows[i]));
    for (const n of [1, 2, 3]) {
      const nameCol = `Option${n} Name`;
      const valCol = `Option${n} Value`;
      if (!has(valCol)) continue;
      const anyValue = variantRows.some((i) => get(rows[i], valCol) !== '');
      if (anyValue && get(first, nameCol) === '') {
        const laterName = idxs.map((i) => get(rows[i], nameCol)).find(Boolean);
        if (laterName) set(first, idxs[0], nameCol, laterName, 'fixed', 'option_name_moved', `${nameCol} must be on the product's first row — copied it there.`);
        else report('error', 'option_name_missing', `${valCol} is filled in but ${nameCol} is blank (e.g. "Size", "Colour").`, idxs[0], nameCol);
      }
      if (n > 1 && anyValue && has(`Option${n - 1} Value`) && variantRows.some((i) => get(rows[i], `Option${n - 1} Value`) === '')) {
        report('warning', 'option_gap', `Option${n} is used but Option${n - 1} is empty on some variants. Shopify needs options filled in order.`, variantRows[0], valCol);
      }
      if (anyValue) {
        const blanks = variantRows.filter((i) => get(rows[i], valCol) === '');
        for (const i of blanks) report('error', 'option_value_missing', `Variant is missing a value for ${get(first, nameCol) || nameCol}.`, i, valCol);
      }
    }

    if (variantRows.length > 1 && has('Option1 Value') && variantRows.every((i) => get(rows[i], 'Option1 Value') === '')) {
      report('error', 'variants_without_options', `Product "${handle}" has ${variantRows.length} variant rows but no option values (like Size or Colour). Add option values, or delete the extra rows if they are duplicates.`, variantRows[1], 'Option1 Value');
    }

    // Single default variant without options -> Title / Default Title.
    if (has('Option1 Name') && has('Option1 Value') && variantRows.length <= 1) {
      const vr = variantRows.length ? variantRows[0] : idxs[0];
      if (get(first, 'Option1 Name') === '' && get(rows[vr], 'Option1 Value') === '') {
        set(first, idxs[0], 'Option1 Name', 'Title', 'fixed', 'default_option', 'Product has a single variant — set Option1 Name to "Title" as Shopify expects.');
        set(rows[vr], vr, 'Option1 Value', 'Default Title', 'fixed', 'default_option', 'Product has a single variant — set Option1 Value to "Default Title" as Shopify expects.');
      }
    }

    // Duplicate variant combinations
    if (variantRows.length > 1) {
      const combos = new Map();
      for (const i of variantRows) {
        const combo = [1, 2, 3].map((n) => get(rows[i], `Option${n} Value`).toLowerCase()).join(' / ');
        if (combo.replace(/[ /]/g, '') === '') continue;
        if (combos.has(combo)) report('error', 'duplicate_variant', `Duplicate variant "${combo.replace(/( \/ )+$/, '')}" — also on row ${combos.get(combo) + 2}. Shopify rejects duplicate option combinations.`, i, 'Option1 Value');
        else combos.set(combo, i);
      }
    }
  }

  /* ---------- 5. Field-level normalisation ---------- */
  const skuSeen = new Map();
  rows.forEach((r, ri) => {
    const isVariant = hasVariantData(r);

    for (const name of PRICE_COLS) {
      const raw = get(r, name);
      if (raw === '') continue;
      const p = parsePrice(raw);
      if (p === null) report('error', 'price_invalid', `"${truncate(raw, 30)}" isn't a valid price. Use a number like 19.99.`, ri, name);
      else if (p.value < 0) report('error', 'price_negative', 'Price cannot be negative.', ri, name);
      else set(r, ri, name, p.text, 'fixed', 'price_format', 'Price reformatted to a plain number with 2 decimals (no currency symbols or thousand separators).');
    }

    if (isVariant && has('Variant Price') && get(r, 'Variant Price') === '') {
      report('error', 'price_missing', 'Variant has no price. Shopify rejects this row with "Validation failed: price can\'t be blank".', ri, 'Variant Price');
    }

    const price = parseFloat(get(r, 'Variant Price'));
    const compare = parseFloat(get(r, 'Variant Compare At Price'));
    if (Number.isFinite(price) && Number.isFinite(compare) && compare <= price && /^\d+\.\d{2}$/.test(get(r, 'Variant Compare At Price'))) {
      set(r, ri, 'Variant Compare At Price', '', 'fixed', 'compare_at_cleared', `Compare-at price (${compare.toFixed(2)}) wasn't higher than the price (${price.toFixed(2)}), so it would never show as a sale — cleared it.`);
    }

    for (const name of BOOL_COLS) {
      const raw = get(r, name);
      if (raw === '') continue;
      const b = parseBool(raw);
      if (b === null) report('error', 'bool_invalid', `"${truncate(raw, 30)}" should be true or false.`, ri, name);
      else set(r, ri, name, b, 'fixed', 'bool_format', `Normalised to ${b} (Shopify only accepts true or false).`);
    }

    // Inventory policy (also handles the new template's TRUE/FALSE "Continue selling" column)
    const pol = get(r, 'Variant Inventory Policy');
    if (pol !== '') {
      const v = pol.toLowerCase();
      const mapped = v === 'deny' || FALSE_WORDS.has(v) || v === 'stop' ? 'deny' : v === 'continue' || TRUE_WORDS.has(v) || v === 'allow' ? 'continue' : null;
      if (mapped) set(r, ri, 'Variant Inventory Policy', mapped, 'fixed', 'policy_format', 'Inventory policy must be "deny" or "continue".');
      else report('error', 'policy_invalid', 'Inventory policy must be "deny" (stop selling when out of stock) or "continue".', ri, 'Variant Inventory Policy');
    } else if (isVariant && has('Variant Inventory Policy')) {
      set(r, ri, 'Variant Inventory Policy', 'deny', 'fixed', 'policy_default', 'Blank inventory policy — set to "deny" (Shopify\'s default: stop selling when out of stock).');
    }

    const tracker = get(r, 'Variant Inventory Tracker');
    if (tracker !== '') {
      if (tracker.toLowerCase() === 'shopify') set(r, ri, 'Variant Inventory Tracker', 'shopify', 'fixed', 'tracker_format', 'Inventory tracker should be lowercase "shopify".');
      else if (['none', 'no', 'false', 'n/a'].includes(tracker.toLowerCase())) set(r, ri, 'Variant Inventory Tracker', '', 'fixed', 'tracker_format', 'Inventory tracker must be "shopify" or blank — cleared it (inventory not tracked).');
    }

    const fs = get(r, 'Variant Fulfillment Service');
    if (fs !== '') {
      if (fs.toLowerCase() === 'manual') set(r, ri, 'Variant Fulfillment Service', 'manual', 'fixed', 'fulfillment_format', 'Fulfillment service should be lowercase "manual".');
    } else if (isVariant && has('Variant Fulfillment Service')) {
      set(r, ri, 'Variant Fulfillment Service', 'manual', 'fixed', 'fulfillment_default', 'Blank fulfillment service — set to "manual" (Shopify\'s default).');
    }

    const grams = get(r, 'Variant Grams');
    if (grams !== '') {
      const gramsNum = grams.replace(/\s*(g|grams?)$/i, '');
      const g = parseInteger(gramsNum, { allowNegative: false });
      if (/^\d*\.\d+$/.test(gramsNum) && Number(gramsNum) < 10) {
        report('error', 'grams_suspicious', `Variant Grams is ${gramsNum} — that looks like kilograms or pounds. Enter the weight in whole grams (e.g. ${Math.round(Number(gramsNum) * 1000)} for ${gramsNum} kg).`, ri, 'Variant Grams');
      } else if (g === null) report('error', 'grams_invalid', 'Variant Grams must be a whole number of grams (e.g. 250).', ri, 'Variant Grams');
      else set(r, ri, 'Variant Grams', g, 'fixed', 'grams_format', 'Variant Grams must be a whole number.');
    }

    const qty = get(r, 'Variant Inventory Qty');
    if (qty === '' && isVariant && has('Variant Inventory Qty') && get(r, 'Variant Inventory Tracker') === 'shopify') {
      set(r, ri, 'Variant Inventory Qty', '0', 'fixed', 'qty_default', 'Blank inventory quantity on a tracked variant — set to 0 (Shopify rejects blanks with "Inventory quantity can\'t be blank").');
    } else if (qty !== '') {
      const q = parseInteger(qty);
      if (q === null) report('error', 'qty_invalid', 'Inventory quantity must be a whole number.', ri, 'Variant Inventory Qty');
      else set(r, ri, 'Variant Inventory Qty', q, 'fixed', 'qty_format', 'Inventory quantity must be a whole number.');
    }

    const unit = get(r, 'Variant Weight Unit');
    if (unit !== '') {
      const u = WEIGHT_UNITS.get(unit.toLowerCase().replace(/\.$/, ''));
      if (u) set(r, ri, 'Variant Weight Unit', u, 'fixed', 'weight_unit_format', 'Weight unit must be one of g, kg, lb, oz.');
      else report('error', 'weight_unit_invalid', 'Weight unit must be g, kg, lb or oz.', ri, 'Variant Weight Unit');
    }

    const status = get(r, 'Status');
    if (status !== '') {
      const s = STATUS.get(status.toLowerCase());
      if (s) set(r, ri, 'Status', s, 'fixed', 'status_format', 'Status must be lowercase "active", "draft" or "archived".');
      else report('error', 'status_invalid', 'Status must be "active", "draft" or "archived".', ri, 'Status');
    }

    for (const name of IMAGE_COLS) {
      const raw = get(r, name);
      if (raw === '') continue;
      const res = fixImageUrl(raw);
      if (res.error) report('error', 'image_invalid', res.error, ri, name);
      else if (res.url !== raw) set(r, ri, name, res.url, 'fixed', 'image_url', res.note || 'Cleaned image URL.');
    }

    const pos = get(r, 'Image Position');
    if (pos !== '') {
      const p = parseInteger(pos, { allowNegative: false });
      if (p === null || p === '0') report('error', 'image_position_invalid', 'Image Position must be a whole number starting at 1.', ri, 'Image Position');
      else set(r, ri, 'Image Position', p, 'fixed', 'image_position_format', 'Image Position must be a whole number.');
    }
    if (pos === '' && get(r, 'Image Src') === '' && get(r, 'Image Alt Text') !== '') {
      report('warning', 'alt_without_image', 'Image Alt Text is set but there is no Image Src on this row.', ri, 'Image Alt Text');
    }

    const tags = get(r, 'Tags');
    if (tags !== '') {
      const sep = tags.includes(',') ? ',' : /[;|]/.test(tags) ? /[;|]/ : ',';
      const seenTags = new Set();
      const list = [];
      for (const t of tags.split(sep)) {
        const clean = t.replace(/\s+/g, ' ').trim();
        if (!clean || seenTags.has(clean.toLowerCase())) continue;
        seenTags.add(clean.toLowerCase());
        list.push(clean.slice(0, 255));
      }
      set(r, ri, 'Tags', list.join(', '), 'fixed', 'tags_format', 'Tags cleaned: comma-separated, trimmed, duplicates removed.');
    }

    for (const name of ['Variant SKU', 'Variant Barcode']) {
      let v = get(r, name);
      if (v === '') continue;
      if (v.startsWith("'") && v.length > 1) set(r, ri, name, (v = v.slice(1)), 'fixed', 'leading_apostrophe', 'Removed Excel\'s leading apostrophe.');
      if (/^\d+(\.\d+)?e\+?\d+$/i.test(v)) {
        report('error', 'scientific_notation', `"${v}" looks like Excel converted this number to scientific notation, which loses digits. Re-type the full value (and format the column as Text in Excel).`, ri, name);
      } else if (name === 'Variant Barcode' && /^\d+\.0+$/.test(v)) {
        set(r, ri, name, v.replace(/\.0+$/, ''), 'fixed', 'barcode_decimal', 'Removed ".0" that Excel added to the barcode.');
      }
    }
    const sku = get(r, 'Variant SKU');
    if (sku !== '') {
      const k = sku.toLowerCase();
      if (skuSeen.has(k)) report('warning', 'duplicate_sku', `SKU "${truncate(sku, 40)}" is also used on row ${skuSeen.get(k) + 2}. Duplicate SKUs make inventory and order tracking confusing.`, ri, 'Variant SKU');
      else skuSeen.set(k, ri);
    }

    const seoTitle = get(r, 'SEO Title');
    if (seoTitle.length > 70) report('warning', 'seo_title_long', `SEO Title is ${seoTitle.length} characters — Shopify allows 70; search engines will cut it off.`, ri, 'SEO Title');
    const seoDesc = get(r, 'SEO Description');
    if (seoDesc.length > 320) report('warning', 'seo_desc_long', `SEO Description is ${seoDesc.length} characters — Shopify allows 320.`, ri, 'SEO Description');
    const title = titleOf(r);
    if (title.length > 255) report('error', 'title_long', `Title is ${title.length} characters — Shopify's limit is 255.`, ri, 'Title');
  });

  const summary = {
    rows: rows.length,
    columns: headers.length,
    products: groups.size,
    fixed: counts.fixed,
    warnings: counts.warning,
    errors: counts.error,
    truncatedIssues: counts.fixed + counts.warning + counts.error > issues.length,
    byCode: Object.values(byCode).sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.count - a.count),
  };

  return { headers, rows, issues, summary };
}

function sevRank(s) {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}

function truncate(s, n = 120) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Short group labels for the summary panel.
const CODE_LABELS = {
  encoding: 'File encoding converted to UTF-8',
  ragged_row: 'Rows padded to line up with headers',
  empty_column: 'Empty columns removed',
  unnamed_column: 'Columns with no header',
  duplicate_column: 'Duplicate columns',
  header_renamed: 'Column names corrected for Shopify',
  added_handle_column: 'Handle column added',
  missing_title_column: 'Title column missing',
  blank_rows: 'Empty rows removed',
  mojibake: 'Garbled characters repaired',
  whitespace: 'Stray spaces / invisible characters cleaned',
  handle_generated: 'Handles generated from titles',
  handle_inherited: 'Handles filled in on variant rows',
  handle_missing: 'Rows with no Handle',
  handle_invalid: 'Invalid handles',
  handle_format: 'Handles reformatted',
  handle_conflict: 'Handles shared by different products',
  handle_split: 'Product rows not grouped together',
  title_moved: 'Titles moved to first product row',
  title_missing: 'Products with no title',
  option_name_moved: 'Option names moved to first row',
  option_name_missing: 'Option names missing',
  option_gap: 'Options not filled in order',
  option_value_missing: 'Variant option values missing',
  default_option: 'Single-variant options set to Default Title',
  duplicate_variant: 'Duplicate variants',
  price_invalid: 'Invalid prices',
  price_negative: 'Negative prices',
  price_format: 'Prices reformatted',
  price_missing: 'Variants with no price',
  compare_at_cleared: 'Compare-at prices not above price (cleared)',
  bool_invalid: 'Invalid TRUE/FALSE values',
  bool_format: 'TRUE/FALSE values normalised',
  policy_format: 'Inventory policies normalised',
  policy_invalid: 'Invalid inventory policies',
  policy_default: 'Blank inventory policies set to deny',
  tracker_format: 'Inventory trackers normalised',
  fulfillment_format: 'Fulfillment services normalised',
  fulfillment_default: 'Blank fulfillment services set to manual',
  grams_invalid: 'Invalid weights',
  grams_suspicious: 'Weights that look like kg/lb, not grams',
  duplicate_row: 'Exact duplicate rows removed',
  variants_without_options: 'Multiple variants with no options',
  grams_format: 'Weights normalised',
  qty_invalid: 'Invalid inventory quantities',
  qty_format: 'Inventory quantities normalised',
  qty_default: 'Blank inventory quantities set to 0',
  weight_unit_format: 'Weight units normalised',
  weight_unit_invalid: 'Invalid weight units',
  status_format: 'Statuses normalised',
  status_invalid: 'Invalid statuses',
  image_invalid: 'Invalid image URLs',
  image_url: 'Image URLs fixed',
  image_position_invalid: 'Invalid image positions',
  image_position_format: 'Image positions normalised',
  alt_without_image: 'Alt text with no image',
  tags_format: 'Tags cleaned',
  leading_apostrophe: 'Excel apostrophes removed',
  scientific_notation: 'Numbers mangled into scientific notation',
  barcode_decimal: 'Barcodes with ".0" fixed',
  duplicate_sku: 'Duplicate SKUs',
  seo_title_long: 'SEO titles too long',
  seo_desc_long: 'SEO descriptions too long',
  title_long: 'Titles too long',
};

function summaryMessage(code, fallback) {
  return CODE_LABELS[code] || fallback;
}

module.exports = { fixShopifyCsv, parsePrice, parseBool, slugify, fixMojibake, fixImageUrl, CANONICAL };
