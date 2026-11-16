import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from render_readme_charts import bundle_data, benchmark_data, sample_stats, update_benchmark_table

ROOT = Path(__file__).resolve().parents[1]


class ReadmeChartTests(unittest.TestCase):
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
