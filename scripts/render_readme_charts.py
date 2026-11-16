# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["matplotlib==3.10.7", "numpy==2.2.6"]
# ///
"""Render README figures from measured bytes and individual timing samples."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs/images"
MANIFEST = OUTPUT / "comparison-data.json"
INPUTS = ["measurements/bundle-size-current.json", "measurements/sqlite-speed-current.json", "measurements/catalog-profiles-current.json"]
FIGURES = ["bundle-size", "catalog-runtime-size", "sqlite-benchmark"]
CATALOG_LABELS = {
    "readonly": "Read only",
    "scalar-read": "GLOB + char",
    "json-construct": "JSON construction",
    "json-nested": "Nested JSON",
    "json-cte": "Recursive CTE + JSON aggregate",
    "notes": "Notes CRUD",
}
CATALOG_JAPANESE = {
    "readonly": "読取専用",
    "scalar-read": "GLOB + char",
    "json-construct": "JSON生成",
    "json-nested": "入れ子JSON",
    "json-cte": "再帰CTE＋JSON集約",
    "notes": "Notes CRUD",
}
LABELS = {
    "sql-js": "SQLike · SQL · JS",
    "sql-wasm": "SQLike · SQL · Wasm GC",
    "defined-all-js": "SQLike · predefined · full · JS",
    "defined-all-wasm": "SQLike · predefined · full · Wasm GC",
    "defined-without-three-js": "SQLike · predefined · trimmed · JS",
    "defined-without-three-wasm": "SQLike · predefined · trimmed · Wasm GC",
    "defined-primary-key-js": "SQLike · predefined · PK only · JS",
    "defined-primary-key-wasm": "SQLike · predefined · PK only · Wasm GC",
    "sqlite": "sqlite-wasm",
    "turso": "Turso",
}
ENGINES = ["sqlike-js/dynamic", "sqlike-wasm/dynamic", "sqlite/dynamic", "sqlite/prepared"]
ENGINE_LABELS = ["SQLike JS", "SQLike Wasm GC", "SQLite SQL", "SQLite prepared"]
COLORS = ["#2563eb", "#0d9488", "#d97706", "#64748b"]
QUERIES = [
    ("point", "Primary-key lookup"),
    ("miss", "Missing primary key"),
    ("range", "Indexed range · 10 rows"),
    ("limit", "ORDER BY id · LIMIT 10"),
    ("aggregate", "SUM + COUNT · 5,000 rows"),
    ("scan", "Fetch all 5,000 rows"),
    ("index-update-range", "Indexed UPDATE + range read"),
]
JAPANESE_LABELS = ["主キーで1行検索", "存在しない主キーの検索", "二次索引の範囲検索・10行", "ORDER BY id LIMIT 10", "sum(n), count(*)", "全5,000行取得", "索引列の更新＋範囲10行取得"]


def positive(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("expected a finite positive measurement")
    return value


def bundle_data(report):
    ids = [r["id"] for r in report["results"]]
    if len(ids) != len(LABELS) or set(ids) != set(LABELS):
        raise ValueError("all ten distinct bundle builds must appear")
    if report.get("browserSmoke") != "passed":
        raise ValueError("bundle execution verification missing")
    rows = []
    for row in report["results"]:
        raw, brotli = (positive(row["totals"][k]) for k in ["raw", "brotli"])
        for key in ["raw", "brotli"]:
            if row["totals"][key] != sum(a[key] for a in row["assets"]):
                raise ValueError("bundle assets do not add up")
        rows.append({"id": row["id"], "label": LABELS[row["id"]], "raw_kib": raw / 1024, "brotli_kib": brotli / 1024})
    return rows


def catalog_data(report):
    if report.get("format") != "sqlike-catalog-profiles@1":
        raise ValueError("unsupported catalog measurement format")
    expected = {(fixture, mode) for fixture in CATALOG_LABELS for mode in ["aot", "defined"]}
    pairs = [(r["id"], r["mode"]) for r in report["results"]]
    if len(pairs) != len(expected) or set(pairs) != expected:
        raise ValueError("all twelve distinct catalog/mode builds must appear")
    rows = []
    for source in report["results"]:
        if source.get("verified") is not True or source.get("operations", 0) <= 0:
            raise ValueError("native catalog execution verification missing")
        row = {"id": source["id"], "mode": source["mode"], "label": CATALOG_LABELS[source["id"]]}
        for kind in ["baseline", "selected"]:
            row[kind] = {target: {compression: positive(source["assets"][kind][target][compression]) / 1024
                                  for compression in ["raw", "brotli"]} for target in ["js", "wasm"]}
        rows.append(row)
    return rows


def sample_stats(samples):
    if len(samples) != 7 or sorted(s["run"] for s in samples) != list(range(7)):
        raise ValueError("expected seven distinct timing runs")
    values = [positive(s["milliseconds"]) * 1000 / positive(s["iterations"]) for s in samples]
    return {"median": statistics.median(values), "min": min(values), "max": max(values)}


def benchmark_data(report):
    if report.get("smoke") is not False:
        raise ValueError("smoke timings must not be published")
    datasets = [r for r in report["results"] if r["rows"] == 5000 and r["coldRows"] == 0]
    if len(datasets) != 1 or datasets[0]["verified"] != 48:
        raise ValueError("expected the verified 5,000-row six-path dataset")
    data = datasets[0]
    result = []
    for name, label in QUERIES:
        series = []
        for engine in ENGINES:
            samples = (next(r for r in data["indexLifecycle"] if r["engine"] == engine)["samples"]
                       if name == "index-update-range" else
                       [r for r in data["samples"] if r["name"] == name and r["engine"] == engine])
            stats = sample_stats(samples)
            if name != "index-update-range":
                stored = next(r for r in data["medians"] if r["name"] == name and r["engine"] == engine)
                if not math.isclose(stats["median"], stored["microseconds"], rel_tol=1e-12):
                    raise ValueError("stored median disagrees with individual samples")
            series.append({"engine": engine, "stats": stats})
        result.append({"id": name, "label": label, "series": series})
    return result


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def update_benchmark_table(markdown, rows, language="en"):
    if language not in ["en", "ja"]:
        raise ValueError("unsupported README language")
    start, end = "<!-- sqlite-benchmark:start -->", "<!-- sqlite-benchmark:end -->"
    if markdown.count(start) != 1 or markdown.count(end) != 1 or markdown.index(start) >= markdown.index(end):
        raise ValueError("README benchmark markers must occur exactly once and in order")
    header = ("| Workload | SQLike JS, SQL | SQLike Wasm GC, SQL | SQLite WASM, SQL | SQLite WASM, prepared |" if language == "en" else
              "| 処理 | SQLike JS・通常SQL | SQLike Wasm GC・通常SQL | SQLite WASM・通常SQL | SQLite WASM・prepared |")
    labels = [row["label"] for row in rows] if language == "en" else JAPANESE_LABELS
    table = [header, "| --- | ---: | ---: | ---: | ---: |"]
    for label, row in zip(labels, rows):
        values = " | ".join(f"{s['stats']['median']:,.2f}" for s in row["series"])
        table.append(f"| {label} | {values} |")
    begin, finish = markdown.index(start) + len(start), markdown.index(end)
    return markdown[:begin] + "\n" + "\n".join(table) + "\n" + markdown[finish:]


def update_catalog_table(markdown, rows, language="en"):
    if language not in ["en", "ja"]:
        raise ValueError("unsupported README language")
    start, end = "<!-- catalog-runtime-size:start -->", "<!-- catalog-runtime-size:end -->"
    if markdown.count(start) != 1 or markdown.count(end) != 1 or markdown.index(start) >= markdown.index(end):
        raise ValueError("README catalog markers must occur exactly once and in order")
    header = ("| Catalog / mode | Minified JS | JS Brotli | Release Wasm | Wasm Brotli |" if language == "en" else
              "| Catalog / モード | minified JS | JS Brotli | release Wasm | Wasm Brotli |")
    table = [header, "| --- | ---: | ---: | ---: | ---: |"]
    for row in rows:
        label = row["label"] if language == "en" else CATALOG_JAPANESE[row["id"]]
        mode = "AOT" if row["mode"] == "aot" else "defined"
        values = " | ".join(f"{row['selected'][target][compression]:.2f} KiB" for target in ["js", "wasm"] for compression in ["raw", "brotli"])
        table.append(f"| {label} / {mode} | {values} |")
    begin, finish = markdown.index(start) + len(start), markdown.index(end)
    return markdown[:begin] + "\n" + "\n".join(table) + "\n" + markdown[finish:]


def save_figure(fig, name, title, description="Generated from repository measurement JSON; exact values are also in the README tables."):
    for extension in ["svg", "png"]:
        metadata = {"Title": title, "Description": description}
        if extension == "svg":
            metadata["Date"] = None
        fig.savefig(OUTPUT / f"{name}.{extension}", dpi=170, facecolor="white", metadata=metadata)


def render_bundle(rows, report, plt):
    fig, ax = plt.subplots(figsize=(12, 7.4))
    fig.subplots_adjust(left=0.335, right=0.965, top=0.79, bottom=0.205)
    fig.text(0.035, 0.94, "Browser bundle size", fontsize=22, weight="bold", color="#0f172a")
    versions = report["versions"]
    fig.text(0.035, 0.897, f"SQLike {versions['sqlike']} · sqlite-wasm {versions['sqlite']} · Turso {versions['turso']}", fontsize=11, color="#475569")
    for y, row in enumerate(rows):
        if y % 2 == 0:
            ax.axhspan(y - 0.46, y + 0.46, color="#f1f5f9", zorder=0)
        ax.plot([row["brotli_kib"], row["raw_kib"]], [y, y], color="#cbd5e1", linewidth=2, zorder=1)
        for key, color in [("brotli_kib", "#2563eb"), ("raw_kib", "#64748b")]:
            ax.scatter([row[key]], [y], s=55, color=color, zorder=3)
            ax.annotate(f"{row[key]:,.2f}", (row[key], y), xytext=(0, 10), textcoords="offset points", ha="center", fontsize=10, color=color)
    ax.scatter([], [], color="#2563eb", s=55, label="Brotli quality 11")
    ax.scatter([], [], color="#64748b", s=55, label="Minified JS + release Wasm (uncompressed)")
    ax.legend(loc="lower right", bbox_to_anchor=(1, 1.03), frameon=False, fontsize=10)
    ax.set_xscale("log", base=2)
    ticks = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384]
    ax.set_xticks(ticks, [f"{v:,}" for v in ticks])
    ax.set_xlim(64, 22000)
    ax.set_ylim(len(rows) - 0.5, -0.8)
    ax.set_yticks(range(len(rows)), [r["label"] for r in rows], fontsize=10.5)
    ax.tick_params(axis="both", length=0, pad=10)
    ax.grid(axis="x", color="#e2e8f0", linewidth=0.7)
    ax.set_axisbelow(True)
    ax.set_xlabel("KiB · logarithmic scale (each tick doubles) · smaller is better", fontsize=11, labelpad=14)
    for spine in ax.spines.values():
        spine.set_visible(False)
    fig.text(0.035, 0.075, "Trimmed = no JSON/date/window. PK only = only the optional primary-key index feature enabled.", fontsize=10, color="#475569")
    fig.text(0.035, 0.045, "All emitted JS, workers and Wasm included. App code, schema/statements, compiler and Litestream excluded.", fontsize=10, color="#475569")
    save_figure(fig, "bundle-size", "Browser bundle size: all ten builds, before/after Brotli")
    plt.close(fig)


def render_catalog(rows, plt):
    selected = [row for row in rows if row["mode"] == "defined"]
    fig, axes = plt.subplots(1, 2, figsize=(12.5, 6.7))
    fig.subplots_adjust(left=0.29, right=0.965, top=0.77, bottom=0.20, wspace=0.12)
    fig.text(0.035, 0.945, "Catalog-selected runtime size", fontsize=22, weight="bold", color="#0f172a")
    fig.text(0.035, 0.895, "Defined mode · JavaScript engine only · primary-key index enabled", fontsize=11, color="#475569")
    for ax, compression, title in zip(axes, ["raw", "brotli"], ["Minified JS (KiB)", "Brotli quality 11 (KiB)"]):
        for y, row in enumerate(selected):
            if y % 2 == 0:
                ax.axhspan(y - 0.46, y + 0.46, color="#f1f5f9", zorder=0)
            before, after = [row[kind]["js"][compression] for kind in ["baseline", "selected"]]
            ax.plot([after, before], [y, y], color="#cbd5e1", linewidth=2, zorder=1)
            for value, color, offset, vertical in [(before, "#64748b", -10, "top"), (after, "#2563eb", 9, "bottom")]:
                ax.scatter([value], [y], s=48, color=color, zorder=3)
                ax.annotate(f"{value:.2f}", (value, y), xytext=(0, offset), textcoords="offset points", ha="center", va=vertical, fontsize=9, color=color)
        ax.set_title(title, loc="left", fontsize=12, weight="bold", pad=15)
        ax.set_xlim(0, max(row["baseline"]["js"][compression] for row in selected) * 1.14)
        ax.set_ylim(len(selected) - 0.5, -0.7)
        ax.set_yticks(range(len(selected)), [row["label"] for row in selected] if ax is axes[0] else [])
        ax.tick_params(axis="both", length=0, pad=9, labelsize=10)
        ax.grid(axis="x", color="#e2e8f0", linewidth=0.7)
        ax.set_axisbelow(True)
        ax.set_xlabel("KiB · smaller is better", fontsize=10, labelpad=10)
        for spine in ax.spines.values():
            spine.set_visible(False)
    axes[0].scatter([], [], color="#64748b", label="Manual feature profile")
    axes[0].scatter([], [], color="#2563eb", label="Catalog-selected")
    fig.legend(*axes[0].get_legend_handles_labels(), loc="upper right", bbox_to_anchor=(0.97, 0.86), ncol=2, frameon=False, fontsize=10)
    fig.text(0.035, 0.075, "Same semantic features and exports per pair. Baseline and selected JS/Wasm verified against native SQLite.", fontsize=10, color="#475569")
    fig.text(0.035, 0.035, "Host, IndexedDB wrappers, schema/statements and compiler excluded. Wasm alternatives are in the README table.", fontsize=10, color="#475569")
    save_figure(fig, "catalog-runtime-size", "Catalog-selected defined JavaScript runtime sizes",
                "Manual profiles versus catalog-selected runtimes. Bytes from measurements/catalog-profiles-current.json; selected JS and Wasm sizes are in the README table.")
    plt.close(fig)


def render_benchmark(rows, report, sqlike_version, plt):
    fig, axes = plt.subplots(4, 2, figsize=(12, 12.6))
    fig.subplots_adjust(left=0.16, right=0.955, top=0.86, bottom=0.095, hspace=0.95, wspace=0.7)
    fig.text(0.035, 0.956, "SQLite comparison · 5,000 rows", fontsize=22, weight="bold", color="#0f172a")
    sqlite_version = next(r["sqliteVersion"] for r in report["results"] if r["rows"] == 5000 and r["coldRows"] == 0)
    fig.text(0.035, 0.921, f"In-memory engine calls · SQLike {sqlike_version} / SQLite WASM {sqlite_version}", fontsize=12, color="#475569")
    fig.text(0.035, 0.892, "SQLike and SQLite SQL: parse/prepare each call. SQLite prepared: statement reused.", fontsize=11, color="#475569")
    for ax, row in zip(axes.flat, rows):
        factor = 1000 if row["id"] == "scan" else 1
        stats = [s["stats"] for s in row["series"]]
        medians = [s["median"] / factor for s in stats]
        errors = [[(s["median"] - s["min"]) / factor for s in stats], [(s["max"] - s["median"]) / factor for s in stats]]
        ax.barh(range(4), medians, color=COLORS, height=0.58, xerr=errors, error_kw={"ecolor": "#334155", "capsize": 3, "elinewidth": 1})
        ax.set_yticks(range(4), ENGINE_LABELS, fontsize=10)
        ax.invert_yaxis()
        for y, value in enumerate(medians):
            ax.annotate(f"{value:,.2f}", (stats[y]["max"] / factor, y), xytext=(5, 0), textcoords="offset points", va="center", fontsize=10, color="#0f172a")
        ax.set_xlim(0, max(s["max"] / factor for s in stats) * 1.3)
        ax.set_title(row["label"], loc="left", fontsize=12, weight="bold", pad=12)
        ax.set_xlabel("ms / operation" if factor == 1000 else "μs / operation", fontsize=10, labelpad=7)
        ax.tick_params(axis="both", length=0, pad=6)
        ax.grid(axis="x", color="#e2e8f0", linewidth=0.7)
        ax.set_axisbelow(True)
        for spine in ax.spines.values():
            spine.set_visible(False)
    note = axes.flat[-1]
    note.set_axis_off()
    note.text(0, 1, "How to read", fontsize=13, weight="bold", va="top", color="#0f172a")
    note.text(0, 0.76, "Each panel starts at zero.\nScales differ across workloads.\n\nNumbers: median of 7 runs.\nWhiskers: observed min–max,\nnot confidence intervals.\n\nLower is faster.", fontsize=11, va="top", color="#475569", linespacing=1.5)
    env = report["environment"]
    system = {"darwin": "macOS", "linux": "Linux", "win32": "Windows"}.get(env["platform"], env["platform"])
    fig.text(0.035, 0.048, f"{env['cpu']} · {system} {env['arch']} · Chromium {env['chromium']} · {report['measuredAt'][:10]}", fontsize=10, color="#475569")
    fig.text(0.035, 0.025, "Warm indexes. Typed result decoding included. Startup, host wrappers, IndexedDB and networking excluded.", fontsize=10, color="#475569")
    save_figure(fig, "sqlite-benchmark", "SQLite comparison: seven workloads and four execution paths")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify input data and generated image hashes without redrawing")
    args = parser.parse_args()
    bundle, benchmark, catalog = [json.loads((ROOT / p).read_text()) for p in INPUTS]
    data = {"bundle": bundle_data(bundle), "benchmark": benchmark_data(benchmark), "catalog": catalog_data(catalog)}
    inputs = {p: sha(ROOT / p) for p in [*INPUTS, "scripts/render_readme_charts.py"]}
    readmes = [(ROOT / "README.md", "en"), (ROOT / "README.ja.md", "ja")]
    updates = [(path, path.read_text(), update_catalog_table(update_benchmark_table(path.read_text(), data["benchmark"], language), data["catalog"], language)) for path, language in readmes]
    if args.check:
        saved = json.loads(MANIFEST.read_text())
        if saved["inputs"] != inputs or saved["data"] != data:
            raise ValueError("stale figures: run just readme-charts")
        if set(saved["outputs"]) != {f"docs/images/{name}.{ext}" for name in FIGURES for ext in ["svg", "png"]}:
            raise ValueError("missing README figure")
        for path, digest in saved["outputs"].items():
            if sha(ROOT / path) != digest:
                raise ValueError(f"image differs: {path}")
        for path, before, after in updates:
            if before != after:
                raise ValueError(f"{path.name} table differs from figure data")
        print("English/Japanese README figures match all three reports, 12 catalog builds and 28 timing medians")
        return
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "svg.hashsalt": "sqlike-readme", "svg.fonttype": "path", "text.color": "#0f172a", "axes.labelcolor": "#475569", "xtick.color": "#475569", "ytick.color": "#334155"})
    OUTPUT.mkdir(parents=True, exist_ok=True)
    render_bundle(data["bundle"], bundle, plt)
    render_catalog(data["catalog"], plt)
    render_benchmark(data["benchmark"], benchmark, bundle["versions"]["sqlike"], plt)
    for path, before, after in updates:
        if before != after:
            path.write_text(after)
    outputs = {str(p.relative_to(ROOT)): sha(p) for name in FIGURES for extension in ["svg", "png"] for p in [OUTPUT / f"{name}.{extension}"]}
    MANIFEST.write_text(json.dumps({"renderer": f"Matplotlib {matplotlib.__version__}", "inputs": inputs, "outputs": outputs, "data": data}, indent=2) + "\n")
    print("Rendered bundle-size, catalog-runtime-size and sqlite-benchmark as SVG + PNG")


if __name__ == "__main__":
    main()
