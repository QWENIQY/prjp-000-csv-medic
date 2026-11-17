"""
CSV Medic — Shopify product CSV fixing engine.

fix_shopify_csv(headers, rows) -> {"headers", "rows", "issues", "summary"}

Pure and deterministic (no I/O), and idempotent: running it on its own output produces no
further "fixed" changes. Used on upload, on re-check from the editor, and again before export.
"""

from __future__ import annotations

import math
import re
import unicodedata
from urllib.parse import urlsplit

# Shopify's product CSV columns (classic template — still accepted by Shopify's importer).
CANONICAL = [
    "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published",
    "Option1 Name", "Option1 Value", "Option1 Linked To",
    "Option2 Name", "Option2 Value", "Option2 Linked To",
    "Option3 Name", "Option3 Value", "Option3 Linked To",
    "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Qty",
    "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price", "Variant Compare At Price",
    "Variant Requires Shipping", "Variant Taxable", "Variant Barcode",
    "Image Src", "Image Position", "Image Alt Text", "Gift Card", "SEO Title", "SEO Description",
    "Variant Image", "Variant Weight Unit", "Variant Tax Code", "Cost per item", "Status",
]

_NON_ALNUM = re.compile(r"[^a-z0-9]")


def _key(s: str) -> str:
    return _NON_ALNUM.sub("", str(s).lower())


def _build_aliases() -> dict[str, str]:
    m = {_key(c): c for c in CANONICAL}

    def add(canon: str, *names: str) -> None:
        for n in names:
            m[_key(n)] = canon

    add("Handle", "URL handle", "product handle", "slug", "url slug", "handles")
    add("Title", "name", "product name", "product title", "title name")
    add("Body (HTML)", "body", "body html", "description", "product description", "description html", "html description", "body_html")
    add("Vendor", "brand", "manufacturer", "supplier")
    add("Product Category", "category", "google product category", "product_category")
    add("Type", "product type", "product_type")
    add("Tags", "tag", "keywords", "product tags")
    add("Published", "published on online store", "published on store", "visible", "is published", "online store")
    add("Variant SKU", "sku", "product sku", "item sku")
    add("Variant Grams", "weight value (grams)", "weight value", "grams", "weight grams", "weight (grams)", "weight in grams", "variant weight grams")
    add("Variant Inventory Tracker", "inventory tracker", "track inventory", "track quantity")
    add("Variant Inventory Qty", "inventory qty", "inventory quantity", "quantity", "qty", "stock", "stock qty", "stock quantity", "inventory", "variant inventory quantity")
    add("Variant Inventory Policy", "inventory policy", "continue selling when out of stock", "continue selling")
    add("Variant Fulfillment Service", "fulfillment service", "fulfilment service", "variant fulfilment service")
    add("Variant Price", "price", "product price", "sale price", "selling price", "retail price")
    add("Variant Compare At Price", "compare at price", "compare-at price", "compare price", "rrp", "msrp", "was price", "original price", "regular price")
    add("Variant Requires Shipping", "requires shipping", "physical product", "shipping required")
    add("Variant Taxable", "taxable", "charge tax", "charge tax on this product")
    add("Variant Barcode", "barcodes", "barcode", "upc", "ean", "gtin", "isbn", "barcode (isbn, upc, gtin, etc.)")
    add("Image Src", "image", "image url", "image link", "product image", "product image url", "image source", "images", "main image")
    add("Image Position", "image order", "image index")
    add("Image Alt Text", "alt text", "image alt", "alt")
    add("Gift Card", "is gift card", "giftcard")
    add("SEO Title", "meta title", "page title", "seo_title")
    add("SEO Description", "meta description", "seo_description")
    add("Variant Image", "variant image url", "variant image src")
    add("Variant Weight Unit", "weight unit for display", "weight unit", "unit of weight", "weight unit for variant", "variant weight unit")
    add("Variant Tax Code", "tax code")
    add("Cost per item", "cost", "unit cost", "item cost", "cost price", "variant cost")
    add("Status", "product status", "state")
    for i in (1, 2, 3):
        add(f"Option{i} Name", f"option {i} name", f"option{i}name", f"option{i}")
        add(f"Option{i} Value", f"option {i} value", f"option{i}value", f"option {i} values")
        add(f"Option{i} Linked To", f"option {i} linked to")
    return m


ALIASES = _build_aliases()

PRICE_COLS = ["Variant Price", "Variant Compare At Price", "Cost per item"]
BOOL_COLS = ["Published", "Variant Requires Shipping", "Variant Taxable", "Gift Card"]
IMAGE_COLS = ["Image Src", "Variant Image"]
VARIANT_COLS = [
    "Option1 Value", "Option2 Value", "Option3 Value", "Variant SKU", "Variant Price", "Variant Grams",
    "Variant Inventory Qty", "Variant Barcode", "Variant Compare At Price",
]

MAX_DETAILED_ISSUES = 5000

# ---------------------------------------------------------------------------
# Text-level helpers
# ---------------------------------------------------------------------------

# Windows-1252 code points for bytes 0x80–0x9F (used to reverse "mojibake").
CP1252 = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
    0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91,
    0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
    0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
}
MOJIBAKE_HINT = re.compile("[ÂÃâÅÆÐÑ][\u0080-¿Œ-ƒˆ˜–-™]")

# Zero-width chars, BOMs, and control characters (keeping \t \n \r).
INVISIBLE = re.compile("[​-‍⁠﻿\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]")


def fix_mojibake(s: str) -> str:
    """Repair UTF-8 text that was mis-decoded as Windows-1252 (e.g. "Ã©" -> "é", "â€™" -> "’")."""
    if not MOJIBAKE_HINT.search(s):
        return s
    out = bytearray()
    for ch in s:
        c = ord(ch)
        if c < 0x100:
            out.append(c)
        elif c in CP1252:
            out.append(CP1252[c])
        else:
            return s  # contains characters that can't be mojibake — leave alone
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        return s


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
    s = s.replace("&", " and ")
    s = re.sub("['’\"]", "", s)
    s = re.sub(r"[\W_]+", "-", s)
    return s.strip("-")[:255]


_CURRENCY_CODES = "gbp|usd|eur|aud|cad|nzd|chf|sek|nok|dkk|jpy|inr"


def _js_round(x: float) -> int:
    return math.floor(x + 0.5)


def parse_price(raw: str):
    """Parse a human-entered price ("£1,299.00", "12,99 €", "USD 5") -> {"value", "text"}; None if unparseable."""
    s = str(raw).strip()
    if s == "":
        return ""
    s = re.sub(rf"^({_CURRENCY_CODES})\s*", "", s, flags=re.I)
    s = re.sub(rf"\s*({_CURRENCY_CODES})$", "", s, flags=re.I)
    s = re.sub("[£$€¥₹\\s ']", "", s)
    s = re.sub(r"^(a|c|nz|us)(?=\d)", "", s, flags=re.I)
    neg = False
    if re.fullmatch(r"\(.*\)", s):
        neg, s = True, s[1:-1]
    if s.startswith("-"):
        neg, s = True, s[1:]
    if not re.fullmatch(r"[\d.,]+", s) or not re.search(r"\d", s):
        return None
    last_dot, last_comma = s.rfind("."), s.rfind(",")
    if last_dot != -1 and last_comma != -1:
        # Whichever separator comes last is the decimal separator.
        s = s.replace(".", "").replace(",", ".", 1) if last_comma > last_dot else s.replace(",", "")
    elif last_comma != -1:
        parts = s.split(",")
        # "12,99" -> decimal comma; "1,299" / "1,299,000" -> thousands
        s = ".".join(parts) if len(parts) == 2 and len(parts[1]) != 3 else "".join(parts)
    elif s.count(".") > 1:
        s = s.replace(".", "")  # "1.299.000" thousands dots
    try:
        v = float(s)
    except ValueError:
        return None
    if not math.isfinite(v):
        return None
    v = -v if neg else v
    return {"value": v, "text": f"{v:.2f}"}


TRUE_WORDS = {"true", "t", "yes", "y", "1", "on", "published", "visible", "active", "enabled"}
FALSE_WORDS = {"false", "f", "no", "n", "0", "off", "unpublished", "hidden", "draft", "disabled"}


def parse_bool(raw: str):
    s = str(raw).strip()
    if re.fullmatch(r"(true|false)", s, flags=re.I):
        return s  # already valid — Shopify accepts any case
    v = s.lower()
    if v in TRUE_WORDS:
        return "true"
    if v in FALSE_WORDS:
        return "false"
    return None


def parse_integer(raw: str, allow_negative: bool = True):
    s = re.sub(r"[,\s]", "", str(raw).strip())
    if s == "":
        return ""
    if re.fullmatch(r"-?\d+(\.0+)?", s):
        v = int(re.sub(r"\.0+$", "", s))
    elif re.fullmatch(r"-?\d*\.\d+", s):
        v = _js_round(float(s))
    else:
        return None
    if not allow_negative and v < 0:
        return None
    return str(v)


WEIGHT_UNITS = {
    "g": "g", "gr": "g", "gram": "g", "grams": "g", "gramme": "g", "grammes": "g",
    "kg": "kg", "kgs": "kg", "kilo": "kg", "kilos": "kg", "kilogram": "kg", "kilograms": "kg",
    "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
    "oz": "oz", "ounce": "oz", "ounces": "oz",
}

STATUS = {
    "active": "active", "live": "active", "published": "active", "enabled": "active", "on": "active", "true": "active",
    "draft": "draft", "hidden": "draft", "unpublished": "draft", "disabled": "draft", "off": "draft", "false": "draft", "pending": "draft",
    "archived": "archived", "archive": "archived", "deleted": "archived", "discontinued": "archived",
}

_DOMAIN_PATH = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/\S", re.I)
_DRIVE = re.compile(r"^https?://drive\.google\.com/(?:file/d/([A-Za-z0-9_-]+)|open\?id=([A-Za-z0-9_-]+))", re.I)


def fix_image_url(raw: str) -> dict:
    """Clean an image URL. Returns {"url", "note"} or {"error"}."""
    s = str(raw).strip()
    if s == "":
        return {"url": ""}
    note = None
    if s.startswith("//"):
        s, note = "https:" + s, "Added https: to protocol-relative URL"
    elif re.match(r"^www\.", s, re.I) or _DOMAIN_PATH.match(s):
        s, note = "https://" + s, "Added https:// to URL"
    if not re.match(r"^https?://", s, re.I):
        return {"error": "Image URL must start with http:// or https:// — Shopify downloads images from the web, it cannot use a file on your computer."}
    drive = _DRIVE.match(s)
    if drive:
        s = f"https://drive.google.com/uc?export=download&id={drive.group(1) or drive.group(2)}"
        note = "Converted Google Drive share link to a direct image link"
    if re.match(r"^https?://(www\.)?dropbox\.com/", s, re.I) and re.search(r"[?&]dl=0\b", s):
        s = re.sub(r"([?&])dl=0\b", r"\1raw=1", s, count=1)
        note = "Converted Dropbox share link to a direct image link"
    if re.search(r"\s", s):
        s = re.sub(r"\s", "%20", s)
        note = note or "Encoded spaces in image URL"
    try:
        parts = urlsplit(s)
        if not parts.netloc or parts.hostname is None:
            raise ValueError
    except ValueError:
        return {"error": "Image URL is not a valid web address."}
    return {"url": s, "note": note}


def _truncate(s, n: int = 120) -> str:
    s = str(s)
    return s[: n - 1] + "…" if len(s) > n else s


def _sev_rank(s: str) -> int:
    return 0 if s == "error" else 1 if s == "warning" else 2


_FLOAT_PREFIX = re.compile(r"^\s*[+-]?(\d+(\.\d*)?|\.\d+)")


def _parse_float(s: str):
    m = _FLOAT_PREFIX.match(s)
    return float(m.group(0)) if m else None


# Short group labels for the summary panel.
CODE_LABELS = {
    "encoding": "File encoding converted to UTF-8",
    "ragged_row": "Rows padded to line up with headers",
    "empty_column": "Empty columns removed",
    "unnamed_column": "Columns with no header",
    "duplicate_column": "Duplicate columns",
    "header_renamed": "Column names corrected for Shopify",
    "added_handle_column": "Handle column added",
    "missing_title_column": "Title column missing",
    "blank_rows": "Empty rows removed",
    "duplicate_row": "Exact duplicate rows removed",
    "mojibake": "Garbled characters repaired",
    "whitespace": "Stray spaces / invisible characters cleaned",
    "handle_generated": "Handles generated from titles",
    "handle_inherited": "Handles filled in on variant rows",
    "handle_missing": "Rows with no Handle",
    "handle_invalid": "Invalid handles",
    "handle_format": "Handles reformatted",
    "handle_conflict": "Handles shared by different products",
    "handle_split": "Product rows not grouped together",
    "title_moved": "Titles moved to first product row",
    "title_missing": "Products with no title",
    "option_name_moved": "Option names moved to first row",
    "option_name_missing": "Option names missing",
    "option_gap": "Options not filled in order",
    "option_value_missing": "Variant option values missing",
    "variants_without_options": "Multiple variants with no options",
    "default_option": "Single-variant options set to Default Title",
    "duplicate_variant": "Duplicate variants",
    "price_invalid": "Invalid prices",
    "price_negative": "Negative prices",
    "price_format": "Prices reformatted",
    "price_missing": "Variants with no price",
    "compare_at_cleared": "Compare-at prices not above price (cleared)",
    "bool_invalid": "Invalid true/false values",
    "bool_format": "true/false values normalised",
    "policy_format": "Inventory policies normalised",
    "policy_invalid": "Invalid inventory policies",
    "policy_default": "Blank inventory policies set to deny",
    "tracker_format": "Inventory trackers normalised",
    "fulfillment_format": "Fulfillment services normalised",
    "fulfillment_default": "Blank fulfillment services set to manual",
    "grams_invalid": "Invalid weights",
    "grams_suspicious": "Weights that look like kg/lb, not grams",
    "grams_format": "Weights normalised",
    "qty_invalid": "Invalid inventory quantities",
    "qty_format": "Inventory quantities normalised",
    "qty_default": "Blank inventory quantities set to 0",
    "weight_unit_format": "Weight units normalised",
    "weight_unit_invalid": "Invalid weight units",
    "status_format": "Statuses normalised",
    "status_invalid": "Invalid statuses",
    "image_invalid": "Invalid image URLs",
    "image_url": "Image URLs fixed",
    "image_position_invalid": "Invalid image positions",
    "image_position_format": "Image positions normalised",
    "alt_without_image": "Alt text with no image",
    "tags_format": "Tags cleaned",
    "leading_apostrophe": "Excel apostrophes removed",
    "scientific_notation": "Numbers mangled into scientific notation",
    "barcode_decimal": 'Barcodes with ".0" fixed',
    "duplicate_sku": "Duplicate SKUs",
    "seo_title_long": "SEO titles too long",
    "seo_desc_long": "SEO descriptions too long",
    "title_long": "Titles too long",
}

_UNSET = object()

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def fix_shopify_csv(headers: list, rows: list, pre_notes: list[str] | None = None) -> dict:
    issues: list[dict] = []
    counts = {"fixed": 0, "warning": 0, "error": 0}
    by_code: dict[str, dict] = {}

    def report(severity, code, message, row=None, col=None, before=_UNSET, after=_UNSET):
        counts[severity] += 1
        g = by_code.get(code)
        if g is None:
            g = by_code[code] = {"code": code, "severity": severity, "message": CODE_LABELS.get(code, message), "count": 0}
        g["count"] += 1
        if len(issues) < MAX_DETAILED_ISSUES:
            issue = {"severity": severity, "code": code, "message": message, "row": row, "col": col}
            if before is not _UNSET:
                issue["before"] = _truncate(before)
            if after is not _UNSET:
                issue["after"] = _truncate(after)
            issues.append(issue)

    for note in pre_notes or []:
        report("fixed", "encoding", note)

    # ---------- 1. Headers ----------
    headers = ["" if h is None else str(h) for h in headers]
    rows = [["" if c is None else str(c) for c in r] for r in rows]
    width = max([len(headers)] + [len(r) for r in rows] + [0])

    extra_cols = 0
    while len(headers) < width:
        headers.append("")
    for i, r in enumerate(rows):
        if len(r) < width:
            missing = width - len(r)
            had_content = any(c.strip() != "" for c in r)
            r.extend([""] * missing)
            if had_content and missing < width:
                report("fixed", "ragged_row", f"Row had {missing} missing cell(s) — padded so columns line up.", i)

    keep = [h.strip() != "" or any(r[ci].strip() != "" for r in rows) for ci, h in enumerate(headers)]
    if not all(keep):
        dropped = keep.count(False)
        headers = [h for h, k in zip(headers, keep) if k]
        rows = [[c for c, k in zip(r, keep) if k] for r in rows]
        report("fixed", "empty_column", f"Removed {dropped} completely empty column(s) with no header.")

    seen: dict[str, int] = {}
    new_headers = []
    for ci, h in enumerate(headers):
        clean = re.sub(r"\s+", " ", fix_mojibake(INVISIBLE.sub("", h))).strip()
        if clean == "":
            extra_cols += 1
            name = f"Unnamed column {extra_cols}"
            report("warning", "unnamed_column", f'Column {ci + 1} had data but no header — named it "{name}". Shopify ignores columns it doesn\'t recognise.', None, name)
            clean = name
        lower = clean.lower()
        canon = ALIASES.get(_key(clean)) or (clean if lower.startswith("product.metafields") or lower.startswith("variant.metafields") else None)
        final = canon or clean
        if final in seen:
            report("warning", "duplicate_column", f'Column "{clean}" duplicates "{final}" (column {seen[final] + 1}). Kept the first; renamed this one so it is ignored — check which one you meant.', None, clean)
            final = f"{clean} (duplicate)"
        elif final != h:
            report("fixed", "header_renamed", f'Renamed column "{h}" to Shopify\'s "{final}".', None, final, h, final)
        seen[final] = ci
        new_headers.append(final)
    headers = new_headers

    col = {h: i for i, h in enumerate(headers)}

    def has(name: str) -> bool:
        return name in col

    if not has("Handle"):
        headers.insert(0, "Handle")
        for r in rows:
            r.insert(0, "")
        col = {h: i for i, h in enumerate(headers)}
        report("fixed", "added_handle_column", 'Added the required "Handle" column (generated from product titles).')
    if not has("Title"):
        report("error", "missing_title_column", 'No "Title" column found. Shopify needs a Title for every new product.')

    # ---------- 2. Cell-level text cleanup ----------
    body_idx = col.get("Body (HTML)")
    before_count = len(rows)
    rows = [r for r in rows if not all(INVISIBLE.sub("", c).strip() == "" for c in r)]
    removed_blank = before_count - len(rows)
    if removed_blank:
        report("fixed", "blank_rows", f"Removed {removed_blank} empty row(s).")

    seen_rows: set = set()
    deduped = []
    for ri, r in enumerate(rows):
        sig = tuple(c.strip() for c in r)
        if sig in seen_rows:
            report("fixed", "duplicate_row", "Removed a row that was an exact duplicate of an earlier row.", ri)
            continue
        seen_rows.add(sig)
        deduped.append(r)
    rows = deduped

    keep_double_spaces = {col.get("Tags"), col.get("Image Alt Text")}
    for ri, r in enumerate(rows):
        for ci, before in enumerate(r):
            if before == "":
                continue
            stripped = INVISIBLE.sub("", before)
            v = stripped
            demoji = fix_mojibake(v)
            if demoji != v:
                report("fixed", "mojibake", 'Repaired garbled characters (encoding damage, e.g. "Ã©" → "é", "â€™" → "’").', ri, headers[ci], v, demoji)
                v = demoji
            if ci != body_idx:
                v = re.sub(r"[\r\n]+", " ", v.replace(" ", " ")).strip()
                if ci not in keep_double_spaces:
                    v = re.sub(r" {2,}", " ", v)
            else:
                v = v.strip()
            if v != before and demoji == stripped:
                report("fixed", "whitespace", "Cleaned stray spaces, line breaks or invisible characters.", ri, headers[ci], before, v)
            r[ci] = v

    def get(r, name):
        i = col.get(name)
        return r[i] if i is not None else ""

    def put(r, ri, name, value, severity, code, message):
        i = col.get(name)
        if i is None:
            return
        before = r[i]
        if before == value:
            return
        r[i] = value
        report(severity or "fixed", code, message, ri, name, before, value)

    # ---------- 3. Handles ----------
    def title_of(r):
        return get(r, "Title")

    def has_variant_data(r):
        return any(get(r, c) != "" for c in VARIANT_COLS)

    prev_handle = ""
    for ri, r in enumerate(rows):
        h = get(r, "Handle")
        if h == "":
            if title_of(r) != "":
                put(r, ri, "Handle", slugify(title_of(r)), "fixed", "handle_generated", "Generated missing Handle from the product Title.")
            elif prev_handle and (has_variant_data(r) or get(r, "Image Src") != ""):
                put(r, ri, "Handle", prev_handle, "fixed", "handle_inherited", "Missing Handle on a variant/image row — copied from the product above.")
            else:
                report("error", "handle_missing", "Row has no Handle and no Title, so Shopify cannot tell which product it belongs to.", ri, "Handle")
            h = get(r, "Handle")
        if h != "":
            clean = slugify(h)
            if clean == "":
                report("error", "handle_invalid", "Handle contains no letters or numbers.", ri, "Handle")
            elif clean != h:
                put(r, ri, "Handle", clean, "fixed", "handle_format", "Handle reformatted: lowercase letters, numbers and hyphens only.")
            prev_handle = get(r, "Handle")

    # ---------- 4. Group rows into products ----------
    groups: dict[str, list[int]] = {}
    blocks: dict[str, int] = {}
    for ri, r in enumerate(rows):
        h = get(r, "Handle")
        if not h:
            continue
        if h not in groups:
            groups[h] = []
            blocks[h] = 1
        elif groups[h][-1] != ri - 1:
            blocks[h] += 1
        groups[h].append(ri)

    for handle, idxs in groups.items():
        titles = list(dict.fromkeys(t for t in (title_of(rows[i]) for i in idxs) if t))
        if len(titles) > 1:
            shown = ", ".join(f'"{_truncate(t, 40)}"' for t in titles[:3])
            report("warning", "handle_conflict", f'Handle "{handle}" is shared by products with different titles ({shown}). Shopify will merge them into one product — give each product its own Handle if they are different.', idxs[1], "Handle")
        elif blocks[handle] > 1:
            report("warning", "handle_split", f'Rows for "{handle}" are not next to each other. Shopify still groups them, but keeping a product\'s rows together avoids mistakes.', idxs[0], "Handle")

        first = rows[idxs[0]]
        if has("Title") and title_of(first) == "":
            later = next((i for i in idxs if title_of(rows[i]) != ""), None)
            if later is not None:
                put(first, idxs[0], "Title", title_of(rows[later]), "fixed", "title_moved", "Title must be on the first row of a product — copied it from a later row.")
            else:
                report("warning", "title_missing", f'Product "{handle}" has no Title. That\'s fine when updating an existing product, but new products need one.', idxs[0], "Title")

        variant_rows = [i for i in idxs if has_variant_data(rows[i])]
        for n in (1, 2, 3):
            name_col, val_col = f"Option{n} Name", f"Option{n} Value"
            if not has(val_col):
                continue
            any_value = any(get(rows[i], val_col) != "" for i in variant_rows)
            if any_value and get(first, name_col) == "":
                later_name = next((get(rows[i], name_col) for i in idxs if get(rows[i], name_col)), "")
                if later_name:
                    put(first, idxs[0], name_col, later_name, "fixed", "option_name_moved", f"{name_col} must be on the product's first row — copied it there.")
                else:
                    report("error", "option_name_missing", f'{val_col} is filled in but {name_col} is blank (e.g. "Size", "Colour").', idxs[0], name_col)
            prev_val = f"Option{n - 1} Value"
            if n > 1 and any_value and has(prev_val) and any(get(rows[i], prev_val) == "" for i in variant_rows):
                report("warning", "option_gap", f"Option{n} is used but Option{n - 1} is empty on some variants. Shopify needs options filled in order.", variant_rows[0], val_col)
            if any_value:
                for i in variant_rows:
                    if get(rows[i], val_col) == "":
                        report("error", "option_value_missing", f"Variant is missing a value for {get(first, name_col) or name_col}.", i, val_col)

        if len(variant_rows) > 1 and has("Option1 Value") and all(get(rows[i], "Option1 Value") == "" for i in variant_rows):
            report("error", "variants_without_options", f'Product "{handle}" has {len(variant_rows)} variant rows but no option values (like Size or Colour). Add option values, or delete the extra rows if they are duplicates.', variant_rows[1], "Option1 Value")

        if has("Option1 Name") and has("Option1 Value") and len(variant_rows) <= 1:
            vr = variant_rows[0] if variant_rows else idxs[0]
            if get(first, "Option1 Name") == "" and get(rows[vr], "Option1 Value") == "":
                put(first, idxs[0], "Option1 Name", "Title", "fixed", "default_option", 'Product has a single variant — set Option1 Name to "Title" as Shopify expects.')
                put(rows[vr], vr, "Option1 Value", "Default Title", "fixed", "default_option", 'Product has a single variant — set Option1 Value to "Default Title" as Shopify expects.')

        if len(variant_rows) > 1:
            combos: dict[str, int] = {}
            for i in variant_rows:
                combo = " / ".join(get(rows[i], f"Option{n} Value").lower() for n in (1, 2, 3))
                if re.sub(r"[ /]", "", combo) == "":
                    continue
                if combo in combos:
                    label = re.sub(r"( / )+$", "", combo)
                    report("error", "duplicate_variant", f'Duplicate variant "{label}" — also on row {combos[combo] + 2}. Shopify rejects duplicate option combinations.', i, "Option1 Value")
                else:
                    combos[combo] = i

    # ---------- 5. Field-level normalisation ----------
    sku_seen: dict[str, int] = {}
    for ri, r in enumerate(rows):
        is_variant = has_variant_data(r)

        for name in PRICE_COLS:
            raw = get(r, name)
            if raw == "":
                continue
            p = parse_price(raw)
            if p is None:
                report("error", "price_invalid", f'"{_truncate(raw, 30)}" isn\'t a valid price. Use a number like 19.99.', ri, name)
            elif p["value"] < 0:
                report("error", "price_negative", "Price cannot be negative.", ri, name)
            else:
                put(r, ri, name, p["text"], "fixed", "price_format", "Price reformatted to a plain number with 2 decimals (no currency symbols or thousand separators).")

        if is_variant and has("Variant Price") and get(r, "Variant Price") == "":
            report("error", "price_missing", 'Variant has no price. Shopify rejects this row with "Validation failed: price can\'t be blank".', ri, "Variant Price")

        price = _parse_float(get(r, "Variant Price"))
        compare = _parse_float(get(r, "Variant Compare At Price"))
        if price is not None and compare is not None and compare <= price and re.fullmatch(r"\d+\.\d{2}", get(r, "Variant Compare At Price")):
            put(r, ri, "Variant Compare At Price", "", "fixed", "compare_at_cleared", f"Compare-at price ({compare:.2f}) wasn't higher than the price ({price:.2f}), so it would never show as a sale — cleared it.")

        for name in BOOL_COLS:
            raw = get(r, name)
            if raw == "":
                continue
            b = parse_bool(raw)
            if b is None:
                report("error", "bool_invalid", f'"{_truncate(raw, 30)}" should be true or false.', ri, name)
            else:
                put(r, ri, name, b, "fixed", "bool_format", f"Normalised to {b} (Shopify only accepts true or false).")

        pol = get(r, "Variant Inventory Policy")
        if pol != "":
            v = pol.lower()
            mapped = "deny" if (v == "deny" or v in FALSE_WORDS or v == "stop") else "continue" if (v == "continue" or v in TRUE_WORDS or v == "allow") else None
            if mapped:
                put(r, ri, "Variant Inventory Policy", mapped, "fixed", "policy_format", 'Inventory policy must be "deny" or "continue".')
            else:
                report("error", "policy_invalid", 'Inventory policy must be "deny" (stop selling when out of stock) or "continue".', ri, "Variant Inventory Policy")
        elif is_variant and has("Variant Inventory Policy"):
            put(r, ri, "Variant Inventory Policy", "deny", "fixed", "policy_default", 'Blank inventory policy — set to "deny" (Shopify\'s default: stop selling when out of stock).')

        tracker = get(r, "Variant Inventory Tracker")
        if tracker != "":
            if tracker.lower() == "shopify":
                put(r, ri, "Variant Inventory Tracker", "shopify", "fixed", "tracker_format", 'Inventory tracker should be lowercase "shopify".')
            elif tracker.lower() in ("none", "no", "false", "n/a"):
                put(r, ri, "Variant Inventory Tracker", "", "fixed", "tracker_format", 'Inventory tracker must be "shopify" or blank — cleared it (inventory not tracked).')

        fs = get(r, "Variant Fulfillment Service")
        if fs != "":
            if fs.lower() == "manual":
                put(r, ri, "Variant Fulfillment Service", "manual", "fixed", "fulfillment_format", 'Fulfillment service should be lowercase "manual".')
        elif is_variant and has("Variant Fulfillment Service"):
            put(r, ri, "Variant Fulfillment Service", "manual", "fixed", "fulfillment_default", 'Blank fulfillment service — set to "manual" (Shopify\'s default).')

        grams = get(r, "Variant Grams")
        if grams != "":
            grams_num = re.sub(r"\s*(g|grams?)$", "", grams, flags=re.I)
            g = parse_integer(grams_num, allow_negative=False)
            if re.fullmatch(r"\d*\.\d+", grams_num) and float(grams_num) < 10:
                report("error", "grams_suspicious", f"Variant Grams is {grams_num} — that looks like kilograms or pounds. Enter the weight in whole grams (e.g. {_js_round(float(grams_num) * 1000)} for {grams_num} kg).", ri, "Variant Grams")
            elif g is None:
                report("error", "grams_invalid", "Variant Grams must be a whole number of grams (e.g. 250).", ri, "Variant Grams")
            else:
                put(r, ri, "Variant Grams", g, "fixed", "grams_format", "Variant Grams must be a whole number.")

        qty = get(r, "Variant Inventory Qty")
        if qty == "" and is_variant and has("Variant Inventory Qty") and get(r, "Variant Inventory Tracker") == "shopify":
            put(r, ri, "Variant Inventory Qty", "0", "fixed", "qty_default", 'Blank inventory quantity on a tracked variant — set to 0 (Shopify rejects blanks with "Inventory quantity can\'t be blank").')
        elif qty != "":
            q = parse_integer(qty)
            if q is None:
                report("error", "qty_invalid", "Inventory quantity must be a whole number.", ri, "Variant Inventory Qty")
            else:
                put(r, ri, "Variant Inventory Qty", q, "fixed", "qty_format", "Inventory quantity must be a whole number.")

        unit = get(r, "Variant Weight Unit")
        if unit != "":
            u = WEIGHT_UNITS.get(re.sub(r"\.$", "", unit.lower()))
            if u:
                put(r, ri, "Variant Weight Unit", u, "fixed", "weight_unit_format", "Weight unit must be one of g, kg, lb, oz.")
            else:
                report("error", "weight_unit_invalid", "Weight unit must be g, kg, lb or oz.", ri, "Variant Weight Unit")

        status = get(r, "Status")
        if status != "":
            st = STATUS.get(status.lower())
            if st:
                put(r, ri, "Status", st, "fixed", "status_format", 'Status must be lowercase "active", "draft" or "archived".')
            else:
                report("error", "status_invalid", 'Status must be "active", "draft" or "archived".', ri, "Status")

        for name in IMAGE_COLS:
            raw = get(r, name)
            if raw == "":
                continue
            res = fix_image_url(raw)
            if "error" in res:
                report("error", "image_invalid", res["error"], ri, name)
            elif res["url"] != raw:
                put(r, ri, name, res["url"], "fixed", "image_url", res.get("note") or "Cleaned image URL.")

        pos = get(r, "Image Position")
        if pos != "":
            p = parse_integer(pos, allow_negative=False)
            if p is None or p == "0":
                report("error", "image_position_invalid", "Image Position must be a whole number starting at 1.", ri, "Image Position")
            else:
                put(r, ri, "Image Position", p, "fixed", "image_position_format", "Image Position must be a whole number.")
        if pos == "" and get(r, "Image Src") == "" and get(r, "Image Alt Text") != "":
            report("warning", "alt_without_image", "Image Alt Text is set but there is no Image Src on this row.", ri, "Image Alt Text")

        tags = get(r, "Tags")
        if tags != "":
            parts = tags.split(",") if "," in tags else re.split(r"[;|]", tags)
            seen_tags: set = set()
            out = []
            for t in parts:
                clean = re.sub(r"\s+", " ", t).strip()
                if not clean or clean.lower() in seen_tags:
                    continue
                seen_tags.add(clean.lower())
                out.append(clean[:255])
            put(r, ri, "Tags", ", ".join(out), "fixed", "tags_format", "Tags cleaned: comma-separated, trimmed, duplicates removed.")

        for name in ("Variant SKU", "Variant Barcode"):
            v = get(r, name)
            if v == "":
                continue
            if v.startswith("'") and len(v) > 1:
                v = v[1:]
                put(r, ri, name, v, "fixed", "leading_apostrophe", "Removed Excel's leading apostrophe.")
            if re.fullmatch(r"\d+(\.\d+)?e\+?\d+", v, flags=re.I):
                report("error", "scientific_notation", f'"{v}" looks like Excel converted this number to scientific notation, which loses digits. Re-type the full value (and format the column as Text in Excel).', ri, name)
            elif name == "Variant Barcode" and re.fullmatch(r"\d+\.0+", v):
                put(r, ri, name, re.sub(r"\.0+$", "", v), "fixed", "barcode_decimal", 'Removed ".0" that Excel added to the barcode.')

        sku = get(r, "Variant SKU")
        if sku != "":
            k = sku.lower()
            if k in sku_seen:
                report("warning", "duplicate_sku", f'SKU "{_truncate(sku, 40)}" is also used on row {sku_seen[k] + 2}. Duplicate SKUs make inventory and order tracking confusing.', ri, "Variant SKU")
            else:
                sku_seen[k] = ri

        seo_title = get(r, "SEO Title")
        if len(seo_title) > 70:
            report("warning", "seo_title_long", f"SEO Title is {len(seo_title)} characters — Shopify allows 70; search engines will cut it off.", ri, "SEO Title")
        seo_desc = get(r, "SEO Description")
        if len(seo_desc) > 320:
            report("warning", "seo_desc_long", f"SEO Description is {len(seo_desc)} characters — Shopify allows 320.", ri, "SEO Description")
        title = title_of(r)
        if len(title) > 255:
            report("error", "title_long", f"Title is {len(title)} characters — Shopify's limit is 255.", ri, "Title")

    summary = {
        "rows": len(rows),
        "columns": len(headers),
        "products": len(groups),
        "fixed": counts["fixed"],
        "warnings": counts["warning"],
        "errors": counts["error"],
        "truncatedIssues": counts["fixed"] + counts["warning"] + counts["error"] > len(issues),
        "byCode": sorted(by_code.values(), key=lambda g: (_sev_rank(g["severity"]), -g["count"])),
    }
    return {"headers": headers, "rows": rows, "issues": issues, "summary": summary}
