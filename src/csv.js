'use strict';

/**
 * Low-level CSV helpers: byte decoding, delimiter sniffing, RFC 4180 parsing
 * (tolerant of common real-world breakage) and serialisation.
 */

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode an uploaded file's bytes into a string, detecting the encoding.
 * Handles UTF-8 (with/without BOM), UTF-16 LE/BE (Excel "Unicode Text"),
 * and falls back to Windows-1252 (Excel "CSV" on Windows) when bytes are not valid UTF-8.
 */
function decodeBuffer(buf) {
  const notes = [];
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    notes.push('File was UTF-16 (LE) encoded — converted to UTF-8.');
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le', notes };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    notes.push('File was UTF-16 (BE) encoded — converted to UTF-8.');
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be', notes };
  }
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3;
    notes.push('Removed byte-order mark (BOM) from the start of the file.');
  }
  const body = buf.subarray(start);
  try {
    return { text: utf8Fatal.decode(body), encoding: 'utf-8', notes };
  } catch {
    notes.push('File was not UTF-8 (looked like Windows-1252 / Excel) — converted to UTF-8 so accents and symbols survive import.');
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'windows-1252', notes };
  }
}

/** Guess the delimiter by counting candidates (outside quotes) on the first few lines. */
function sniffDelimiter(text) {
  const candidates = [',', ';', '\t', '|'];
  const counts = Object.fromEntries(candidates.map((c) => [c, 0]));
  let inQuotes = false;
  let lines = 0;
  const limit = Math.min(text.length, 64 * 1024);
  for (let i = 0; i < limit; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === '\n') {
        if (++lines >= 5) break;
      } else if (ch in counts) counts[ch]++;
    }
  }
  let best = ',';
  for (const c of candidates) if (counts[c] > counts[best]) best = c;
  return best;
}

/**
 * Parse CSV text into an array of rows (arrays of strings).
 * Quoted fields may contain delimiters, quotes ("") and newlines.
 * A stray quote inside an unquoted field is kept literally.
 */
function parse(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  const n = text.length;
  let inQuotes = false;
  let fieldStarted = false; // whether current field began with a quote
  let unterminated = false;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !fieldStarted && field === '') {
      inQuotes = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStarted = false;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) unterminated = true;
  if (field !== '' || row.length > 0 || fieldStarted) {
    row.push(field);
    rows.push(row);
  }
  return { rows, unterminated };
}

function needsQuoting(v) {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v);
}

/** Serialise rows to CSV: comma-separated, LF line endings, UTF-8 without BOM — as Shopify's import docs specify. */
function serialize(headers, rows) {
  const out = [];
  const line = (cells) =>
    cells
      .map((c) => {
        const v = c == null ? '' : String(c);
        return needsQuoting(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      })
      .join(',');
  out.push(line(headers));
  for (const r of rows) out.push(line(r));
  return out.join('\n') + '\n';
}

module.exports = { decodeBuffer, sniffDelimiter, parse, serialize };
