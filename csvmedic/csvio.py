"""Low-level CSV helpers: byte decoding, delimiter sniffing, tolerant parsing and serialisation."""

from __future__ import annotations

import csv
import io
import re
import sys

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

_SURROGATE = re.compile("[\udc80-\udcff]")


def decode_bytes(data: bytes) -> tuple[str, str, list[str]]:
    """Decode an uploaded file, detecting UTF-8 (with/without BOM), UTF-16 and Windows-1252 (Excel)."""
    notes: list[str] = []
    if data[:2] == b"\xff\xfe":
        notes.append("File was UTF-16 (LE) encoded — converted to UTF-8.")
        return data[2:].decode("utf-16-le", errors="replace"), "utf-16le", notes
    if data[:2] == b"\xfe\xff":
        notes.append("File was UTF-16 (BE) encoded — converted to UTF-8.")
        return data[2:].decode("utf-16-be", errors="replace"), "utf-16be", notes
    if data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
        notes.append("Removed byte-order mark (BOM) from the start of the file.")
    try:
        return data.decode("utf-8"), "utf-8", notes
    except UnicodeDecodeError:
        notes.append("File was not UTF-8 (looked like Windows-1252 / Excel) — converted to UTF-8 so accents and symbols survive import.")
        # cp1252 leaves 5 byte values undefined; map them to the same-numbered code point like browsers do.
        text = data.decode("cp1252", errors="surrogateescape")
        text = _SURROGATE.sub(lambda m: chr(ord(m.group()) - 0xDC00), text)
        return text, "windows-1252", notes


def sniff_delimiter(text: str) -> str:
    """Guess the delimiter by counting candidates (outside quotes) on the first few lines."""
    counts = {",": 0, ";": 0, "\t": 0, "|": 0}
    in_quotes = False
    lines = 0
    for ch in text[: 64 * 1024]:
        if ch == '"':
            in_quotes = not in_quotes
        elif not in_quotes:
            if ch == "\n":
                lines += 1
                if lines >= 5:
                    break
            elif ch in counts:
                counts[ch] += 1
    best = ","
    for c in (",", ";", "\t", "|"):
        if counts[c] > counts[best]:
            best = c
    return best


def parse(text: str, delimiter: str = ",") -> tuple[list[list[str]], bool]:
    """Parse CSV text into rows. Tolerant of stray quotes. Returns (rows, probably_unterminated)."""
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, quotechar='"', doublequote=True, strict=False)
    rows = [row for row in reader]
    unterminated = False
    if rows and text.count('"') % 2 == 1:
        last = rows[-1][-1] if rows[-1] else ""
        unterminated = "\n" in last or delimiter in last
    return rows, unterminated


def serialize(headers: list[str], rows: list[list[str]]) -> str:
    """Comma-separated, LF line endings, UTF-8 without BOM — as Shopify's import docs specify."""
    out = io.StringIO()
    writer = csv.writer(out, delimiter=",", quotechar='"', lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(headers)
    for r in rows:
        writer.writerow([c.replace("\r\n", "\n").replace("\r", "\n") if "\r" in c else c for c in r])
    return out.getvalue()
