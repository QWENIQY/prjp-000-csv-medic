'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixShopifyCsv, parsePrice, slugify, fixMojibake, fixImageUrl } = require('../src/fixer');
const { parse, serialize, decodeBuffer, sniffDelimiter } = require('../src/csv');

const run = (csv) => {
  const { rows } = parse(csv.trim(), sniffDelimiter(csv));
  const [headers, ...data] = rows;
  return fixShopifyCsv({ headers, rows: data });
};
const cell = (res, row, name) => res.rows[row][res.headers.indexOf(name)];

test('parsePrice handles currencies and separators', () => {
  assert.equal(parsePrice('£12,99').text, '12.99');
  assert.equal(parsePrice('$1,299.00').text, '1299.00');
  assert.equal(parsePrice('1.299,50 €').text, '1299.50');
  assert.equal(parsePrice('1,299').text, '1299.00');
  assert.equal(parsePrice('49.5 GBP').text, '49.50');
  assert.equal(parsePrice('abc'), null);
  assert.equal(parsePrice('-5').value, -5);
});

test('slugify makes Shopify handles', () => {
  assert.equal(slugify("Men's Classic Tee!"), 'mens-classic-tee');
  assert.equal(slugify('Café & Crème'), 'cafe-and-creme');
  assert.equal(slugify('  --Hello__World-- '), 'hello-world');
});

test('fixMojibake repairs double-encoded UTF-8 only', () => {
  assert.equal(fixMojibake('CafÃ©'), 'Café');
  assert.equal(fixMojibake('itâ€™s'), 'it’s');
  assert.equal(fixMojibake('Café'), 'Café');
  assert.equal(fixMojibake('日本'), '日本');
});

test('fixImageUrl converts share links and rejects local paths', () => {
  assert.equal(fixImageUrl('drive.google.com/file/d/abc123/view').url, 'https://drive.google.com/uc?export=download&id=abc123');
  assert.equal(fixImageUrl('https://drive.google.com/file/d/abc123/view?usp=sharing').url, 'https://drive.google.com/uc?export=download&id=abc123');
  assert.equal(fixImageUrl('https://www.dropbox.com/s/x/a.jpg?dl=0').url, 'https://www.dropbox.com/s/x/a.jpg?raw=1');
  assert.equal(fixImageUrl('//cdn.x.com/a b.jpg').url, 'https://cdn.x.com/a%20b.jpg');
  assert.ok(fixImageUrl('C:\\Users\\me\\a.jpg').error);
});

test('renames headers and generates handles', () => {
  const res = run(`Name,Price,SKU,Published\nOrganic Coffee,£12.99,CB-1,yes`);
  assert.deepEqual(res.headers.slice(0, 5), ['Handle', 'Title', 'Variant Price', 'Variant SKU', 'Published']);
  assert.equal(cell(res, 0, 'Handle'), 'organic-coffee');
  assert.equal(cell(res, 0, 'Variant Price'), '12.99');
  assert.equal(cell(res, 0, 'Published'), 'true');
});

test('variant rows inherit handle and default options are set', () => {
  const res = run(`Handle,Title,Option1 Name,Option1 Value,Variant Price,Variant SKU
tee,Tee,Size,S,10,T-S
,,,M,10,T-M
mug,Mug,,,5,M-1`);
  assert.equal(cell(res, 1, 'Handle'), 'tee');
  assert.equal(cell(res, 2, 'Option1 Name'), 'Title');
  assert.equal(cell(res, 2, 'Option1 Value'), 'Default Title');
  assert.equal(res.summary.products, 2);
});

test('flags duplicates, scientific notation and clears bad compare-at', () => {
  const res = run(`Handle,Title,Option1 Name,Option1 Value,Variant Price,Variant Compare At Price,Variant SKU,Variant Barcode
a,A,Size,S,10,8,X,1.23457E+12
a,,,S,10,,X,`);
  const codes = res.issues.map((i) => i.code);
  assert.ok(codes.includes('duplicate_variant'));
  assert.ok(codes.includes('duplicate_sku'));
  assert.ok(codes.includes('scientific_notation'));
  assert.equal(cell(res, 0, 'Variant Compare At Price'), '');
});

test('is idempotent: fixing fixed output changes nothing', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'messy-products.csv'));
  const { text } = decodeBuffer(buf);
  const { rows } = parse(text, sniffDelimiter(text));
  const first = fixShopifyCsv({ headers: rows[0], rows: rows.slice(1) });
  assert.ok(first.summary.fixed > 20);
  const second = fixShopifyCsv({ headers: first.headers, rows: first.rows.map((r) => [...r]) });
  assert.equal(second.summary.fixed, 0, JSON.stringify(second.issues.filter((i) => i.severity === 'fixed').slice(0, 5)));
  assert.deepEqual(second.rows, first.rows);
});

test('csv round-trip with quotes, commas and newlines', () => {
  const headers = ['A', 'B'];
  const rows = [['x, y', 'say "hi"'], ['line1\nline2', ' padded ']];
  const csv = serialize(headers, rows);
  const back = parse(csv, ',').rows;
  assert.deepEqual(back, [headers, ...rows]);
});

test('decodes windows-1252 and semicolon files', () => {
  const buf = Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x3b, 0x50, 0x72, 0x69, 0x63, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x3b, 0x33, 0x2c, 0x35, 0x30]); // "Name;Price\nCafé;3,50"
  const { text, encoding } = decodeBuffer(buf);
  assert.equal(encoding, 'windows-1252');
  assert.equal(sniffDelimiter(text), ';');
  const res = run(text);
  assert.equal(cell(res, 0, 'Title'), 'Café');
  assert.equal(cell(res, 0, 'Variant Price'), '3.50');
});
