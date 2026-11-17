import copy
import json
from pathlib import Path
import sys
import unittest
import re
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from render_readme_charts import bundle_data, benchmark_data, sample_stats, update_benchmark_table, catalog_data, update_catalog_table, large_benchmark_data, LARGE_ENGINES

ROOT = Path(__file__).resolve().parents[1]


class ReadmeChartTests(unittest.TestCase):
    def test_documentation_embeds_png_previews(self):
        for file in ["README.md", "README.ja.md", "docs/internal/sqlite-large-benchmark.md"]:
            source = (ROOT / file).read_text()
            images = re.findall(r"!\[[^\]]*\]\(([^)]+)\)", source)
            charts = [path for path in images if "images/" in path]
            with self.subTest(file=file):
                self.assertTrue(charts)
                self.assertTrue(all(path.endswith(".png") for path in charts), charts)

    def test_svg_labels_are_text_instead_of_transform_dependent_font_paths(self):
        for name in ["bundle-size", "catalog-runtime-size", "sqlite-benchmark", "sqlite-large-benchmark"]:
            root = ET.parse(ROOT / f"docs/images/{name}.svg").getroot()
            with self.subTest(name=name):
                self.assertGreater(len(root.findall(".//{http://www.w3.org/2000/svg}text")), 0)
                self.assertFalse(any(node.get("id", "").startswith("DejaVuSans")
                                     for node in root.iter("{http://www.w3.org/2000/svg}path")))

    def test_large_chart_covers_all_eight_paths_and_both_real_index_workloads(self):
        report = json.loads((ROOT / "measurements/dynamic-prepare-large-current.json").read_text())
        rows = large_benchmark_data(report)
        self.assertEqual(len(rows), 10)
        data = report["results"][0]
        for row in rows:
            self.assertEqual([s["engine"] for s in row["series"]], LARGE_ENGINES)
            for series in row["series"]:
                samples = (next(r for r in data[row["id"]] if r["engine"] == series["engine"])["samples"]
                           if row["id"] in ["indexLifecycle", "indexMovement"] else
                           [r for r in data["samples"] if r["name"] == row["id"] and r["engine"] == series["engine"]])
                self.assertEqual(series["stats"], sample_stats(samples, runs=3))
        self.assertEqual([r["id"] for r in rows[-2:]], ["indexLifecycle", "indexMovement"])

    def test_large_chart_rejects_incomplete_unverified_or_inconsistent_data(self):
        report = json.loads((ROOT / "measurements/dynamic-prepare-large-current.json").read_text())
        for problem in ["smoke", "unverified", "wrong-size", "missing-path", "missing-index", "wrong-median", "wrong-runs"]:
            invalid = copy.deepcopy(report)
            data = invalid["results"][0]
            if problem == "smoke": invalid["smoke"] = True
            elif problem == "unverified": data["verified"] = 0
            elif problem == "wrong-size": data["rows"] = 5000
            elif problem == "missing-path": data["samples"].pop()
            elif problem == "missing-index": data["indexMovement"].pop()
            elif problem == "wrong-median": data["medians"][0]["microseconds"] *= 2
            else: data["sampling"]["runs"] = 7
            with self.subTest(problem=problem), self.assertRaises(ValueError):
                large_benchmark_data(invalid)

    def test_three_sample_statistics_normalize_iterations_and_reject_duplicate_runs(self):
        samples = [{"run": i, "iterations": n, "milliseconds": ms}
                   for i, (n, ms) in enumerate([(1, 9), (2, 12), (4, 20)])]
        self.assertEqual(sample_stats(samples, runs=3), {"median": 6000, "min": 5000, "max": 9000})
        samples[-1]["run"] = 0
        with self.assertRaises(ValueError): sample_stats(samples, runs=3)

    def test_catalog_sizes_cover_both_modes_and_verified_native_execution(self):
        report = json.loads((ROOT / "measurements/catalog-profiles-current.json").read_text())
        rows = catalog_data(report)
        self.assertEqual(len(rows), 12)
        for row, source in zip(rows, report["results"]):
            self.assertEqual((row["id"], row["mode"]), (source["id"], source["mode"]))
            for kind in ["baseline", "selected"]:
                for target in ["js", "wasm"]:
                    for compression in ["raw", "brotli"]:
                        self.assertEqual(row[kind][target][compression], source["assets"][kind][target][compression] / 1024)
        for problem in ["missing", "duplicate", "unverified", "empty", "invalid-format"]:
            invalid = copy.deepcopy(report)
            if problem == "missing": invalid["results"].pop()
            elif problem == "duplicate": invalid["results"][-1] = invalid["results"][0]
            elif problem == "unverified": invalid["results"][0]["verified"] = False
            elif problem == "empty": invalid["results"][0]["assets"]["selected"]["js"]["raw"] = 0
            else: invalid["format"] = "unknown"
            with self.subTest(problem=problem), self.assertRaises(ValueError):
                catalog_data(invalid)

    def test_catalog_tables_keep_js_and_wasm_separate_in_both_languages(self):
        report = json.loads((ROOT / "measurements/catalog-profiles-current.json").read_text())
        # Distinct sentinels verify the column order without pinning live sizes.
        fixture = next(r for r in report["results"] if r["id"] == "readonly" and r["mode"] == "defined")
        fixture["assets"]["selected"]["js"].update(raw=123 * 1024, brotli=45 * 1024)
        fixture["assets"]["selected"]["wasm"].update(raw=678 * 1024, brotli=90 * 1024)
        rows = catalog_data(report)
        source = "before\n<!-- catalog-runtime-size:start -->\nstale\n<!-- catalog-runtime-size:end -->\nafter\n"
        english, japanese = [update_catalog_table(source, rows, language) for language in ["en", "ja"]]
        self.assertIn("Read only / defined", english)
        self.assertIn("読取専用 / defined", japanese)
        self.assertNotIn("stale", english)
        for table in [english, japanese]:
            self.assertIn("123.00 KiB | 45.00 KiB | 678.00 KiB | 90.00 KiB", table)
            self.assertTrue(table.startswith("before\n<!-- catalog-runtime-size:start -->\n"))
            self.assertTrue(table.endswith("<!-- catalog-runtime-size:end -->\nafter\n"))
            for row in rows:
                selected = row["selected"]
                values = " | ".join(f"{selected[target][compression]:.2f} KiB" for target in ["js", "wasm"] for compression in ["raw", "brotli"])
                self.assertIn(values, table)
        self.assertEqual(update_catalog_table(english, rows), english)
        for invalid in ["missing", source + source]:
            with self.assertRaises(ValueError): update_catalog_table(invalid, rows)

    def test_both_readme_languages_keep_the_same_timing_values(self):
        report = json.loads((ROOT / "measurements/sqlite-speed-current.json").read_text())
        rows = benchmark_data(report)
        source = "before\n<!-- sqlite-benchmark:start -->\nstale\n<!-- sqlite-benchmark:end -->\nafter\n"
        english = update_benchmark_table(source, rows, "en")
        japanese = update_benchmark_table(source, rows, "ja")
        self.assertIn("Primary-key lookup", english)
        self.assertNotIn("主キー", english)
        self.assertIn("主キーで1行検索", japanese)
        for row in rows:
            values = " | ".join(f"{s['stats']['median']:,.2f}" for s in row["series"])
            self.assertIn(values, english)
            self.assertIn(values, japanese)
        self.assertEqual(update_benchmark_table(source, rows), english)

    def test_table_stays_in_microseconds_when_figure_uses_milliseconds(self):
        report = json.loads((ROOT / "measurements/sqlite-speed-current.json").read_text())
        rows = benchmark_data(report)
        current = "before\n<!-- sqlite-benchmark:start -->\nstale\n<!-- sqlite-benchmark:end -->\nafter\n"
        updated = update_benchmark_table(current, rows)
        self.assertEqual(update_benchmark_table(updated, rows), updated)
        self.assertNotIn("stale", updated)
        scan = next(row for row in rows if row["id"] == "scan")
        self.assertIn(f"{scan['series'][0]['stats']['median']:,.2f}", updated)
        self.assertTrue(updated.endswith("<!-- sqlite-benchmark:end -->\nafter\n"))
        with self.assertRaises(ValueError):
            update_benchmark_table("missing markers", rows)

    def test_bundle_includes_every_build_and_both_compression_sizes(self):
        report = json.loads((ROOT / "measurements/bundle-size-current.json").read_text())
        rows = bundle_data(report)
        self.assertEqual(len(rows), 10)
        for row, source in zip(rows, report["results"]):
            self.assertEqual(row["id"], source["id"])
            self.assertEqual(row["raw_kib"], source["totals"]["raw"] / 1024)
            self.assertEqual(row["brotli_kib"], source["totals"]["brotli"] / 1024)
        missing = copy.deepcopy(report)
        missing["results"].pop()
        with self.assertRaises(ValueError):
            bundle_data(missing)
        duplicate = copy.deepcopy(report)
        duplicate["results"][-1] = duplicate["results"][0]
        with self.assertRaises(ValueError):
            bundle_data(duplicate)

    def test_timing_normalizes_each_samples_iteration_count(self):
        samples = [{"run": i, "iterations": 2**i, "milliseconds": 8} for i in range(7)]
        self.assertEqual(sample_stats(samples), {"median": 1000, "min": 125, "max": 8000})
        with self.assertRaises(ValueError):
            sample_stats(samples[:-1])
        invalid = copy.deepcopy(samples)
        invalid[0]["iterations"] = 0
        with self.assertRaises(ValueError):
            sample_stats(invalid)

    def test_benchmark_uses_5000_rows_four_paths_and_real_index_changes(self):
        report = json.loads((ROOT / "measurements/sqlite-speed-current.json").read_text())
        rows = benchmark_data(report)
        self.assertEqual(len(rows), 7)
        data = next(r for r in report["results"] if r["rows"] == 5000 and r["coldRows"] == 0)
        for row in rows:
            self.assertEqual(len(row["series"]), 4)
            for series in row["series"]:
                samples = (next(r for r in data["indexLifecycle"] if r["engine"] == series["engine"])["samples"]
                           if row["id"] == "index-update-range" else
                           [r for r in data["samples"] if r["name"] == row["id"] and r["engine"] == series["engine"]])
                self.assertEqual(series["stats"], sample_stats(samples))
        self.assertEqual(rows[-1]["id"], "index-update-range")
        report["smoke"] = True
        with self.assertRaises(ValueError):
            benchmark_data(report)


if __name__ == "__main__":
    unittest.main()
