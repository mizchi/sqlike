# Changelog

## [Unreleased]

### Added

- Opt-in connection-local SQL statement cache with bounded LRU/text retention, schema-generation invalidation and shared prepared SELECT/UPDATE plans. Preserve the uncached API and parser-free AOT/defined builds.
- SQLite-compatible `ceil`, `ceiling`, `floor` and `trunc`, with independent `mathRounding` catalog specialization. Preserve INTEGER/REAL storage classes and validate arity before execution.

### Changed

- Write AOT, binary defined and positional SQL result cells directly to the existing JSON wire format, avoiding intermediate Json objects and Maps per cell. Retain the existing string/number formatter and object-row semantics.

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

- npm向けの独立した `@mizchi/sqlike` / `@mizchi/litestream` パッケージ定義、型、JS / Wasm asset、配布tarballの外部consumer検証。通常SQL・parserを含まないbinary実行・compiler・Drizzle・LTXをentryで分離。

- 独立したMoonBitモジュール `mizchi/sqlike` と `mizchi/litestream`。JS / Wasm GCに対応。
- SQLiteサブセットの動的SQL・AOT実行、RETURNING、index、基本trigger、FK、STRICT、RIGHT / FULL JOIN。
- 固定DDLとprepared statementのバイナリ定義、パーサを含まない実行ランタイム、機能別ビルドとOxc圧縮。
- IndexedDBの原子的な行ジャーナル・変更列patch、世代CAS、オフライン再開とACK消失時の復旧。
- SQLite / SQLike / Tursoの同期adapter、利用側の適用可否・競合policy、Node relay / Durable Objects / P2P relayの検証構成。
- LTX v3の生成・直接適用と本家Litestreamでの復元検証。
- 任意のDrizzle adapterと、固定バージョンのDrizzle Kitによるmigration検証。
- native SQLiteとの差分検査、失敗後の非変更検査、Chromiumでの保存・同期E2Eとサイズ・速度計測。

### Changed

- 行ストアのCOWページ、共有する主キー索引、増分更新、AOTの列metadata再利用で、検索・更新・cloneと保存を改善。

対応範囲・導入時の制約は[リリースノート](docs/releases/v0.1.0.md)を参照。SQLite全機能互換は未達。全文検索は任意パッケージ、LSMは実験専用で通常バンドルに含めない。

[0.1.0]: https://github.com/mizchi/sqlike/releases/tag/v0.1.0
[0.1.2]: https://github.com/mizchi/sqlike/releases/tag/v0.1.2
[0.1.1]: https://github.com/mizchi/sqlike/releases/tag/v0.1.1
[Unreleased]: https://github.com/mizchi/sqlike/compare/v0.1.2...HEAD
