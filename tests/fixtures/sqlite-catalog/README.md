# SQLite documentation entry-point inventory

`catalog.json` contains names/signatures and source links extracted from official
SQLite documentation indexes. It records retrieval time and each source HTML's
SHA-256. Deprecated and optional entries are retained.

Regenerate with `just sqlite-catalog`. The scraper fails on missing expected
sections; the audit tests also check required entries and native probe validity.
Changing the inventory invalidates previous feature-audit reports.

This is an inventory of documented entry points, not an exhaustive behavioral
specification, a copy of the upstream Tcl/TH3 tests, or a proof of compatibility.
See `docs/sqlite-feature-audit.md` for the measured gaps and strict gate.
