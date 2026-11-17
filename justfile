default:
    @just --list

install:
    pnpm install

build:
    pnpm build

test:
    pnpm test:core
    pnpm test:unit

check:
    pnpm check
    just sqlite-output-check

# Match independent PR jobs; generated declarations are needed on a fresh checkout.
ci-typecheck:
    pnpm build:core
    pnpm typecheck

ci-node:
    test -x "${LITESTREAM_BIN:?set LITESTREAM_BIN to a real Litestream executable}"
    pnpm test:core
    pnpm test:unit

ci-browser:
    test -x "${LITESTREAM_BIN:?set LITESTREAM_BIN to a real Litestream executable}"
    pnpm build
    pnpm build:moon-wasm
    pnpm test:e2e
    just differential-audit
    just sqlite-output-check

# Check both workspace modules from the repository root.
moon-check:
    moon check --target js
    moon check --target wasm-gc

# Lightweight core additions and opt-in JSON operators, including binary profiles.
staged-compat-check:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/sqlike-basic-compat.test.ts tests/sqlike-basic-expressions.test.ts tests/sqlike-math-rounding.test.ts tests/sqlike-json-operators.test.ts tests/sqlike-app-functions.test.ts tests/sqlike-like-extrema.test.ts tests/sqlike-null-order.test.ts tests/sqlike-named-bind.test.ts tests/sqlike-index-metadata.test.ts tests/sqlike-derived-table.test.ts tests/sqlike-aggregate-filter.test.ts tests/sqlike-json-aggregate.test.ts tests/sqlike-optional-functions.test.ts tests/drizzle-defined.test.ts tests/sqlike-catalog-profile.test.ts tests/sqlike-json-profile.test.ts tests/sqlike-query-profile.test.ts

test-sqlike:
    moon test packages/sqlike/src packages/sqlike/src/compiler --target js
    moon test packages/sqlike/src packages/sqlike/src/compiler --target wasm-gc

# Native SQLite differential gates, including dynamic and precompiled execution.
sqlike-check: test-sqlike
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/moon-database.test.ts tests/sqllogictest.test.ts tests/sqlite-expressions.test.ts tests/sqlite-float.test.ts tests/sqlite-conformance-*.test.ts tests/sqlike-*.test.ts tests/trigger-sync.test.ts tests/aot-conformance.test.ts tests/persistence-delta.test.ts tests/persistence-contract.test.ts

# Use --compare=measurements/<baseline>.json on the same benchmark machine.
sqlike-bench *args:
    pnpm build:core
    pnpm exec tsx scripts/bench-sqlike.ts {{args}}

# Same SQL/SQLite/LTX workload on JS and Wasm GC, in Node and Chromium.
wasm-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/wasm-bench.test.ts
    pnpm exec tsx scripts/bench-wasm.ts {{args}}

# In-memory SQLite WASM comparison and separate Chromium CPU profiles.
sqlite-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/profile-summary.test.ts tests/sqlite-bench-policy.test.ts
    pnpm exec tsx scripts/bench-sqlite.ts {{args}}

# Optional 100k rows, all eight paths. Short samples; keep daily/P0 datasets intact.
sqlite-large-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/sqlite-bench-policy.test.ts
    pnpm exec tsx scripts/bench-sqlite.ts --prepared --rows=100000 --profiles=false {{args}}

# Separate existing AOT/Statement ABI costs; setup is excluded from timing.
aot-phase-bench:
    moon bench packages/sqlike/src/aot_bench_wbtest.mbt --target js --release
    moon bench packages/sqlike/src/aot_bench_wbtest.mbt --target wasm-gc --release

# Opt-in SQL prepared execution: isolated phases, plus the unchanged SQL baselines.
sql-prepare-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx scripts/bench-sqlite.ts --prepared --profile-engines=dynamic,prepared --profile-queries=point,update {{args}}
    pnpm exec tsx scripts/bench-sql-prepare-phases.ts

# Experimental JS-native SELECT results, independent from default npm/runtime entries.
typed-result-bench *args:
    pnpm build:core
    pnpm exec tsx --test tests/sqlike-typed-experiment.test.ts
    pnpm exec tsx scripts/bench-typed-results.ts {{args}}

# Optional --before-dir contains sqlike.js and sqlike.wasm; cases have a time budget.
bulk-write-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/sqlike-insert-allocation.test.ts
    pnpm exec tsx scripts/bench-bulk-write.ts {{args}}

# Separate cold/warm rowid caches, alternating reads, and optional Node CPU profiles.
delete-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/sqlike-delete-cache.test.ts
    pnpm exec tsx scripts/bench-delete.ts {{args}}

# JSON/binary UPDATE: same value, real changes, RETURNING, misses and failures.
# Optional --before-dir holds runtime.{js,wasm} and defined.{js,wasm} snapshots.
aot-update-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx scripts/bench-aot-update.ts {{args}}

# Warm-index fork/UPDATE/DELETE and retained versions; optional previous runtimes.
row-store-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx scripts/bench-row-store.ts {{args}}

# Full public API size, minified JS vs release Wasm GC, gzip/Brotli.
build-size:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx scripts/measure-build-size.ts

# Browser JS/Worker/Wasm totals, Brotli11, exact emitted-bundle smoke, README table.
bundle-size:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/bundle-size.test.ts
    pnpm exec tsx scripts/measure-bundle-size.ts
    just readme-charts

# Static README figures from recorded measurements; uv isolates plotting tools.
readme-charts *args:
    python3 -m unittest discover -s tests -p test_readme_charts.py
    uv run scripts/render_readme_charts.py {{args}}

# Strict IndexedDB snapshot vs semantic row journal vs binary SQLite pages.
indexeddb-bench *args:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/page-delta.test.ts tests/persistence-contract.test.ts tests/aot-persistence.test.ts tests/persistence-format.test.ts
    pnpm exec tsx scripts/bench-indexeddb.ts {{args}}

# Isolated MoonBit ordered KV: whole-row journal vs bounded memtable + sorted runs.
lsm-bench *args:
    moon test packages/sqlike/src/lsm --target js
    moon test packages/sqlike/src/lsm --target wasm-gc
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/lsm.test.ts tests/lsm-bench.test.ts
    pnpm exec tsx scripts/bench-lsm.ts {{args}}

test-litestream:
    moon test packages/litestream/src --target js
    moon test packages/litestream/src --target wasm-gc

dev:
    pnpm dev

relay:
    pnpm relay

do:
    pnpm do:dev

# Fixed DO consumer SQL against native SQLite and real local workerd storage.
do-consumer-check:
    pnpm build
    pnpm typecheck
    pnpm exec tsx --test tests/do-types.test.ts tests/do-consumer.test.ts
    pnpm exec playwright test e2e/do-consumer.spec.ts

# Raw/typed PK, REAL bind, UPDATE, CTE and column RETURNING inside workerd.
do-bench:
    pnpm build:core
    pnpm exec tsx scripts/bench-do.ts

# Optional Drizzle sync driver: generated/custom migrations, native differential,
# IndexedDB offline reopen and real SQLite DO with exclusive rebuild scope.
drizzle-check:
    pnpm build
    pnpm build:moon-wasm
    pnpm typecheck
    pnpm exec tsx --test tests/drizzle*.test.ts tests/positional.test.ts tests/sqlike-migration.test.ts tests/do-consumer.test.ts tests/do-types.test.ts
    pnpm exec playwright test e2e/drizzle.spec.ts e2e/drizzle-do.spec.ts e2e/do-consumer.spec.ts

drizzle-fixtures:
    pnpm exec tsx scripts/generate-drizzle-fixtures.ts

measure-drizzle:
    pnpm build:core
    pnpm exec tsx scripts/measure-drizzle.ts
    pnpm exec tsx scripts/measure-drizzle-defined.ts

e2e:
    pnpm test:e2e

fixtures:
    pnpm fixtures:ltx

measure-runtime *args:
    pnpm measure:runtime {{args}}

diff:
    pnpm test:diff

# Run only the full browser differential corpus against the MoonBit engine.
diff-moon:
    COMPAT_ENGINE=moonbit pnpm test:diff

# Original upstream SQL, typed native comparisons and failed-write rollback.
conformance:
    pnpm test:conformance

# Audit all catalog entries, then fail if any feature is absent or unverified.
sqlite-audit:
    pnpm audit:sqlite

# Refresh the official documentation entry-point inventory (network required).
sqlite-catalog:
    pnpm exec tsx scripts/refresh-sqlite-catalog.ts

# Portable SQL and LTX cores; the browser uses MoonBit's JS backend.
moon-wasm:
    pnpm build:moon-wasm

# Compile application SQL/schema once; the generated module is data only.
compile-sql source output:
    pnpm build:core
    pnpm exec tsx scripts/compile-sql.ts {{quote(source)}} {{quote(output)}}

# Compile fixed DDL and prepared statements into independent binary definitions.
compile-defined source output *args:
    pnpm build:core
    pnpm exec tsx scripts/compile-defined.ts {{quote(source)}} {{quote(output)}} {{args}}

defined-codecs:
    pnpm exec tsx scripts/generate-binary-codecs.ts
    pnpm exec tsx scripts/generate-runtime-capabilities.ts
    moon fmt packages/sqlike/src

defined-check:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm build:defined
    pnpm typecheck
    pnpm exec tsx --test tests/defined*.test.ts tests/aot-conformance.test.ts
    pnpm exec playwright test e2e/defined.spec.ts

measure-defined:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm build:defined
    pnpm exec tsx scripts/measure-defined.ts

# Static JSON/date/window removal, native differential and actual browser IDB.
optional-functions-check:
    pnpm build
    pnpm build:moon-wasm
    pnpm typecheck
    pnpm exec tsx --test tests/oxc-runtime.test.ts tests/sqlike-optional-functions.test.ts tests/sqlike-feature-profiles.test.ts tests/defined*.test.ts tests/aot-conformance.test.ts
    pnpm exec playwright test e2e/defined.spec.ts

measure-optional-functions:
    pnpm build:core
    pnpm exec tsx scripts/measure-optional-functions.ts

# Keep minifier tools out of the project lockfile and runtime dependencies.
probe-minification tools="/tmp/browser-litestream-terser-tools":
    pnpm build:core
    mkdir -p {{quote(tools)}}
    pnpm --dir {{quote(tools)}} add --ignore-scripts --save-exact terser@5.51.2
    node measurements/minification-probe.mjs {{quote(tools + "/node_modules/terser/main.js")}}

# Actual mizchi/x/json checkout in isolated Moon workspaces; no dependency change.
probe-json-facade source="../x":
    pnpm build:core
    node measurements/json-facade-probe.mjs {{quote(source)}} --prepare
    node measurements/json-facade-probe.mjs {{quote(source)}}
    node measurements/json-runtime-facade-probe.mjs {{quote(source)}}

build-lite:
    pnpm build:lite

# Strict native interoperability gate; no skipped Litestream checks.
aot-check litestream:
    test -x {{quote(litestream)}}
    pnpm test:core
    pnpm build
    pnpm build:moon-wasm
    LITESTREAM_BIN={{quote(litestream)}} pnpm exec tsx --test tests/aot*.test.ts tests/ltx-writer.test.ts
    LITESTREAM_BIN={{quote(litestream)}} pnpm exec playwright test -c playwright.lite.config.ts

# Browser-owned LTX upload via both the persistent Node and DO gateways.
aot-upload-check litestream:
    test -x {{quote(litestream)}}
    pnpm build
    pnpm typecheck
    pnpm exec tsx --test tests/aot-upload.test.ts
    LITESTREAM_BIN={{quote(litestream)}} pnpm exec playwright test e2e/aot-upload.spec.ts

measure-aot:
    pnpm measure:aot

# Paired size experiments only; production sources are not replaced.
probe-web-platform:
    pnpm build:core
    pnpm build:catalog
    pnpm exec tsx scripts/probe-web-platform.ts

# Real LTX integration requires an executable Litestream, without skipped tests.
ltx-moon litestream:
    test -x {{quote(litestream)}}
    pnpm build
    LITESTREAM_BIN={{quote(litestream)}} pnpm exec playwright test e2e/moon-ltx.spec.ts

# Optional full-text index, measured separately from the SQL/AOT application.
measure-search:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx scripts/measure-search.ts

# Statically select runtime features; the source workspace remains unchanged.
sqlike-runtime config="examples/profiles/notes-aot.json" output="generated/sqlike":
    pnpm exec tsx scripts/build-sqlike-runtime.ts {{quote(config)}} {{quote(output)}}

# Verify optional feature removal and report JS/Wasm gzip/Brotli sizes.
feature-profiles:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/sqlike-feature-profiles.test.ts tests/sqlike-outer-strict.test.ts tests/sqlike-primary-index.test.ts tests/materialized-sync.test.ts
    pnpm exec tsx scripts/measure-sqlike-profiles.ts

# Infer function families, statement kinds, JSON and relational query parts.
catalog-profiles:
    pnpm build:core
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/sqlike-catalog-profile.test.ts tests/sqlike-json-profile.test.ts tests/sqlike-query-profile.test.ts
    pnpm exec playwright test e2e/catalog-profile.spec.ts
    pnpm exec tsx scripts/measure-catalog-profiles.ts

# Collect both environments before checking the supported differential corpus.
differential-audit:
    pnpm build
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/differential-runner.test.ts
    pnpm exec tsx scripts/audit-sqlike-differential.ts --report-only
    pnpm exec playwright test --config playwright.audit.config.ts e2e/sqlike-differential.audit.ts
    pnpm exec tsx scripts/check-sqlike-differential.ts

# Fail on wrong successful outputs or non-atomic rejection; feature gaps stay visible.
# This does not claim full SQLite feature coverage.
sqlite-output-check:
    pnpm build
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/sqlite-output-gate.test.ts tests/sqlike-output-policy.test.ts
    pnpm exec tsx scripts/audit-sqlite.ts
    pnpm exec playwright test --config playwright.audit.config.ts e2e/sqlite-feature-audit.audit.ts
    pnpm exec tsx scripts/check-sqlite-audit.ts --output-only

# Serial measurements avoid competing CPU workloads and retain source/artifact hashes.
p0-measure:
    pnpm build
    pnpm build:moon-wasm
    pnpm exec tsx --test tests/heap-sampling.test.ts tests/measurement-manifest.test.ts
    pnpm exec tsx scripts/bench-sqlite.ts --profile-queries=aggregate,limit,update
    pnpm exec tsx scripts/bench-aot-update.ts
    pnpm exec tsx scripts/bench-row-store.ts
    pnpm exec tsx scripts/bench-indexeddb.ts
    pnpm exec tsx scripts/bench-indexeddb.ts --blob --output=measurements/indexeddb-blob-current.json
    pnpm exec tsx scripts/measure-build-size.ts
    pnpm exec tsx scripts/measure-aot.ts
    pnpm exec tsx scripts/measure-runtime.ts
    pnpm exec tsx scripts/measure-sqlike-profiles.ts
    pnpm exec tsx scripts/bench-do.ts
    pnpm exec tsx scripts/bench-release-app.ts
    pnpm exec tsx scripts/measure-drizzle.ts
    pnpm exec tsx scripts/measure-drizzle-defined.ts
    pnpm exec tsx scripts/measure-defined.ts
    pnpm exec tsx scripts/measure-optional-functions.ts
    pnpm exec tsx scripts/measure-catalog-profiles.ts

# Native Litestream checks are mandatory; inherit LITESTREAM_BIN from the caller.
p0-check:
    just check
    just differential-audit
    pnpm exec tsx scripts/check-p0.ts --record

# Validate the exact archives and their independent public APIs before publication.
release-pack:
    moon -C packages/sqlike publish --dry-run
    moon -C packages/litestream publish --dry-run
    pnpm exec tsx scripts/check-release-pack.ts

# Independent npm artifacts: exact tarballs, strict types, Node, Chromium IDB,
# offline writes, Wasm GC, LTX and the optional Drizzle entry.
npm-check:
    pnpm test:core
    pnpm test:npm
    pnpm typecheck

# First publication needs an authenticated npm account and may request 2FA.
npm-publish: npm-check
    pnpm exec tsx scripts/publish-npm-packages.ts
    SQLIKE_NPM_REGISTRY=1 pnpm exec tsx --test tests/npm-packages.test.ts
