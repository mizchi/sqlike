# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-20

**Breaking:** The default npm and MoonBit SQLike entries now provide a baseline engine. Applications using JSON, CTEs, triggers or window functions through the default entry must import `@mizchi/sqlike/full` or `mizchi/sqlike/full`. Each MoonBit entry has independent connection/statement types. See the [migration guide](docs/releases/v0.2.0.md#upgrade-from-012).

### Added

- Separate baseline, full and portable AOT engines, plus an optional JS native AOT entry. Custom builds select public API capabilities and can emit one linked JS/Wasm engine or MoonBit source for downstream linking.
- A Vite plugin that scans SQL catalogs, generates query types and size reports, and rebuilds on SQL changes. Browser code imports its generated catalog from `@mizchi/sqlike/aot`; mixing dynamic SQL or another prebuilt engine is rejected.
- Independent optional capabilities for aggregate ORDER BY, row-value comparisons, UPDATE FROM, virtual generated columns and the supported subset of `json_each`/`json_tree`. Add expression defaults, CREATE TABLE AS initialization, integer/string `format`/`printf` conversions and unambiguous single-MIN/MAX representatives.
- An optional incremental SQLite pager with replaceable memory/IndexedDB stores, atomic LTX outbox checkpoints, logical row-chunk snapshots, recovery, retry/ACK handling and checkpoint deferral at the pending-outbox limit.
- Opt-in connection-local SQL statement cache with bounded LRU/text retention, schema-generation invalidation and shared prepared SELECT/UPDATE plans. Preserve the uncached API and parser-free AOT/defined builds.
- SQLite-compatible `ceil`, `ceiling`, `floor` and `trunc`, with independent `mathRounding` catalog specialization. Preserve INTEGER/REAL storage classes and validate arity before execution.
- Experimental MoonBit JS package `mizchi/sqlike/experimental-typed` for prepared SELECT results as native positional values. Keep it outside the default runtime and npm exports; bindings retain the existing JSON format.
- Public `/aot/native` JS entry with typed bindings, reusable SELECT handles, native positional results, explicit finalization and transient binding/result cleanup. Catalog runtime builds accept opt-in `nativeResults: true`, retain SQL-parser removal and emit branded TypeScript handles.

### Changed

- Prune unused expression readers/evaluators, SELECT structures, FK/trigger readers and table access optimizer references in catalog builds. Share compact JSON struct readers while retaining existing catalog and persistence formats.
- Document current engine-only minified/Brotli sizes separately from historical browser-bundle and performance measurements. Publish the main README and npm/Mooncakes package READMEs in English; retain the Japanese root README.
- Write AOT, binary defined and positional SQL result cells directly to the existing JSON wire format, avoiding intermediate Json objects and Maps per cell. Retain the existing string/number formatter and object-row semantics.
- Split large secondary-index row arrays into bounded blocks to reduce key-movement costs. Preserve comparison rules, rollback behavior and storage formats.
- Skip identical row storage writes after evaluating UPDATE semantics, and avoid empty CHECK/trigger setup. Preserve changes, constraints, trigger effects and INTEGER/REAL distinctions.
- Avoid maximum-rowid scans for explicit INSERT keys and cache the live maximum for automatic allocation. Preserve AUTOINCREMENT sequence rules, negative rowids and rollback behavior.
- Use bounded leaves for large rowid-order caches to avoid shifting the entire cache on DELETE. Traverse ordered query ranges sequentially within leaves; preserve read order, trigger effects, rollback and replication formats.

### Fixed

- Recover Vite development builds after rapid corrective SQL saves by coalescing watcher events before compilation. Preserve failed CI check statuses through log pipelines and align CI/publishing with the tested MoonBit toolchain.
- Correct schema object-kind checks, reserved names, trigger namespaces and schema TEXT affinity. Reject unsupported physical `sqlite_schema` metadata instead of returning placeholders.
- Preserve schema/trigger replay ordering, statement atomicity and rejected-write state across the storage and synchronization adapters.

SQLite compatibility remains a tested subset; unsupported or ambiguous outputs may be rejected. See the [0.2.0 notes](docs/releases/v0.2.0.md).

## [0.1.2] - 2026-11-17

### Changed

- Execute fixed-schema UPDATEs and simple primary-key SELECTs through a separate prepared IR in JSON AOT and binary defined runtimes. Bind table/column slots, comparison rules, assignment targets, RETURNING projections and primary-key access once; read rows, parameters, indexes and connection state on each execution. Complex expressions retain the validated AST evaluator.

## [0.1.1] - 2026-11-17

### Added

- Catalog-driven AOT / defined runtime specialization: infer 27 core function families, seven JSON families, statement kinds, JOIN, CTE, recursive CTE, compound SELECT and JSON subtype dependencies. Reject catalogs requiring omitted implementations at load time.
- `analyzeCatalogRequirements()` in `@mizchi/sqlike/compiler`, plus optional `@mizchi/sqlike/drizzle/compiler` and `@mizchi/sqlike/drizzle/prepared` entries for precompiled Drizzle queries and named placeholders.
- SQLite subset support for `IS DISTINCT FROM`, bitwise operators, GLOB, char, sign, LIKE ESCAPE, scalar min/max, NULLS FIRST/LAST, named SQL binds, numeric literal separators and hexadecimal literals, and FROM subqueries with distinct result labels.
- Optional schema index metadata, aggregate FILTER, JSON arrows, and JSON array/object aggregates.
- English and Japanese README comparisons with reproducible minified / Brotli browser and catalog-runtime sizes, plus SQLite benchmark figures.

### Fixed

- Preserve JSON string escapes and JSON subtype through COLLATE, unary plus, TEXT casts, CASE and supported conditional functions. Explicitly reject unsupported subtype propagation through scalar subqueries or min/max in JSON VALUE arguments.
- Preserve SQLite error precedence when a malformed JSON patch target is followed by a NULL patch.
- Match SQLite's U+FFFE / U+FFFF handling in GLOB, LIKE and unicode, and enforce the function argument limit without applying it to SQL IN lists.

### Changed

- SQLike and Litestream npm and MoonBit packages use the same 0.1.1 version. npm publication uses the existing GitHub Actions OIDC workflow.
- Flat JSON construction-only catalog runtimes omit the SQL JSON parser, paths, editing, patching and aggregation. Runtime build tools remain repository tools; compiler analysis and the runtime injection APIs are available from npm.

Recompile fixed catalogs with the 0.1.1 compiler. SQLite compatibility remains a tested subset; unsupported SQL and ambiguous JSON subtype paths are rejected. See the [release notes](docs/releases/v0.1.1.md).

## [0.1.0] - 2026-11-16

### Added

- Separate `@mizchi/sqlike` and `@mizchi/litestream` npm packages, types, JS/Wasm assets and independent tarball consumers. Separate entries for dynamic SQL, parser-free binary execution, the compiler, Drizzle and LTX.
- Independent `mizchi/sqlike` and `mizchi/litestream` MoonBit modules supporting JS and Wasm GC.
- SQLite-subset dynamic SQL and AOT execution, RETURNING, indexes, basic triggers, FK, STRICT and RIGHT/FULL JOIN.
- Binary definitions for fixed DDL and prepared statements, parser-free execution, feature-selected builds and Oxc minification.
- Atomic IndexedDB row journals, column patches, generation CAS, offline reopening and recovery after lost ACKs.
- SQLite/SQLike/Turso synchronization adapters, application-defined apply/conflict policies, and Node relay, Durable Objects and P2P relay examples.
- LTX v3 generation/direct application and restore verification with upstream Litestream.
- Optional Drizzle adapters and migration validation with a pinned Drizzle Kit version.
- Native SQLite differential checks, unchanged-state checks after failures, Chromium persistence/sync E2E tests, and size/performance measurements.

### Changed

- Improve reads, updates, cloning and persistence with copy-on-write row pages, shared primary-key indexes, incremental updates and reused AOT column metadata.

See the [release notes](docs/releases/v0.1.0.md) for coverage and limitations. Universal SQLite compatibility is not claimed. Full-text search is optional; experimental LSM is excluded from normal bundles.

[0.1.0]: https://github.com/mizchi/sqlike/releases/tag/v0.1.0
[0.1.2]: https://github.com/mizchi/sqlike/releases/tag/v0.1.2
[0.1.1]: https://github.com/mizchi/sqlike/releases/tag/v0.1.1
[0.2.0]: docs/releases/v0.2.0.md
[Unreleased]: https://github.com/mizchi/sqlike/compare/v0.2.0...HEAD
