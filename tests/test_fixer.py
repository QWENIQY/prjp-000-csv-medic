import unittest
from pathlib import Path

from csvmedic.csvio import decode_bytes, parse, serialize, sniff_delimiter
from csvmedic.fixer import fix_image_url, fix_mojibake, fix_shopify_csv, parse_price, slugify

ROOT = Path(__file__).resolve().parent.parent


def run(text):
    rows, _ = parse(text.strip(), sniff_delimiter(text))
    return fix_shopify_csv(rows[0], rows[1:])


def cell(res, row, name):
    return res["rows"][row][res["headers"].index(name)]


class FixerTests(unittest.TestCase):
    def test_parse_price(self):
        self.assertEqual(parse_price("£12,99")["text"], "12.99")
        self.assertEqual(parse_price("$1,299.00")["text"], "1299.00")
        self.assertEqual(parse_price("1.299,50 €")["text"], "1299.50")
        self.assertEqual(parse_price("1,299")["text"], "1299.00")
        self.assertEqual(parse_price("49.5 GBP")["text"], "49.50")
        self.assertIsNone(parse_price("abc"))
        self.assertEqual(parse_price("-5")["value"], -5)

    def test_slugify(self):
        self.assertEqual(slugify("Men's Classic Tee!"), "mens-classic-tee")
        self.assertEqual(slugify("Café & Crème"), "cafe-and-creme")
        self.assertEqual(slugify("  --Hello__World-- "), "hello-world")

    def test_mojibake(self):
        self.assertEqual(fix_mojibake("CafÃ©"), "Café")
        self.assertEqual(fix_mojibake("itâ€™s"), "it’s")
        self.assertEqual(fix_mojibake("Café"), "Café")
        self.assertEqual(fix_mojibake("日本"), "日本")

    def test_image_urls(self):
        self.assertEqual(fix_image_url("drive.google.com/file/d/abc123/view")["url"], "https://drive.google.com/uc?export=download&id=abc123")
        self.assertEqual(fix_image_url("https://drive.google.com/file/d/abc123/view?usp=sharing")["url"], "https://drive.google.com/uc?export=download&id=abc123")
        self.assertEqual(fix_image_url("https://www.dropbox.com/s/x/a.jpg?dl=0")["url"], "https://www.dropbox.com/s/x/a.jpg?raw=1")
        self.assertEqual(fix_image_url("//cdn.x.com/a b.jpg")["url"], "https://cdn.x.com/a%20b.jpg")
        self.assertIn("error", fix_image_url("C:\\Users\\me\\a.jpg"))

    def test_headers_and_handles(self):
        res = run("Name,Price,SKU,Published\nOrganic Coffee,£12.99,CB-1,yes")
        self.assertEqual(res["headers"][:5], ["Handle", "Title", "Variant Price", "Variant SKU", "Published"])
        self.assertEqual(cell(res, 0, "Handle"), "organic-coffee")
        self.assertEqual(cell(res, 0, "Variant Price"), "12.99")
        self.assertEqual(cell(res, 0, "Published"), "true")

    def test_variants_and_default_options(self):
        res = run("Handle,Title,Option1 Name,Option1 Value,Variant Price,Variant SKU\ntee,Tee,Size,S,10,T-S\n,,,M,10,T-M\nmug,Mug,,,5,M-1")
        self.assertEqual(cell(res, 1, "Handle"), "tee")
        self.assertEqual(cell(res, 2, "Option1 Name"), "Title")
        self.assertEqual(cell(res, 2, "Option1 Value"), "Default Title")
        self.assertEqual(res["summary"]["products"], 2)

    def test_flags(self):
        res = run("Handle,Title,Option1 Name,Option1 Value,Variant Price,Variant Compare At Price,Variant SKU,Variant Barcode\n"
                  "a,A,Size,S,10,8,X,1.23457E+12\na,,,S,10,,X,")
        codes = {i["code"] for i in res["issues"]}
        self.assertTrue({"duplicate_variant", "duplicate_sku", "scientific_notation"} <= codes)
        self.assertEqual(cell(res, 0, "Variant Compare At Price"), "")

    def test_idempotent_on_sample(self):
        text, _, _ = decode_bytes((ROOT / "public" / "samples" / "messy-products.csv").read_bytes())
        rows, _ = parse(text, sniff_delimiter(text))
        first = fix_shopify_csv(rows[0], rows[1:])
        self.assertGreater(first["summary"]["fixed"], 20)
        second = fix_shopify_csv(first["headers"], [list(r) for r in first["rows"]])
        self.assertEqual(second["summary"]["fixed"], 0, [i for i in second["issues"] if i["severity"] == "fixed"][:5])
        self.assertEqual(second["rows"], first["rows"])

    def test_template_is_clean(self):
        text, _, _ = decode_bytes((ROOT / "public" / "samples" / "shopify-product-template.csv").read_bytes())
        rows, _ = parse(text, ",")
        res = fix_shopify_csv(rows[0], rows[1:])
        self.assertEqual((res["summary"]["errors"], res["summary"]["warnings"]), (0, 0))

    def test_round_trip(self):
        headers, rows = ["A", "B"], [["x, y", 'say "hi"'], ["line1\nline2", "plain"]]
        back, _ = parse(serialize(headers, rows), ",")
        self.assertEqual(back, [headers] + rows)

    def test_windows_1252_semicolons(self):
        text, enc, _ = decode_bytes(b"Name;Price\nCaf\xe9;3,50")
        self.assertEqual(enc, "windows-1252")
        self.assertEqual(sniff_delimiter(text), ";")
        res = run(text)
        self.assertEqual(cell(res, 0, "Title"), "Café")
        self.assertEqual(cell(res, 0, "Variant Price"), "3.50")

    def test_utf16(self):
        text, enc, _ = decode_bytes("Title\tPrice\nMug\t5".encode("utf-16"))
        self.assertTrue(enc.startswith("utf-16"))
        self.assertEqual(sniff_delimiter(text), "\t")


if __name__ == "__main__":
    unittest.main()
