# 0.2.0 publication verification

Published on November 20, 2026 (JST). [GitHub Release](https://github.com/mizchi/sqlike/releases/tag/v0.2.0) · [Complete verification record](../../measurements/release-0.2.0.json).

## Source and CI

PR [#10](https://github.com/mizchi/sqlike/pull/10) was merged as `2388df91793fdb1fbfd1acd554d4ad2f9c37c768`. The annotated `v0.2.0` tag points to the tested release commit `e4dcad8860ec60d2d032a966d247c30c0f8125c7`; its tree matches the merge commit. The tag has not moved.

All four [Linux CI jobs](https://github.com/mizchi/sqlike/actions/runs/44574482800) passed: types, core, browser and build graph. MoonBit JS/Wasm each passed 96 tests, Node 584 and Chromium 73. Each differential audit checked 601 cases and 3,606 results with zero failing checks. The Linux feature inventory observed 508 matching probes and 229 atomic rejections per target, with zero successful-output mismatches. The local preparation inventory had one additional rejected probe; retain the individual environment snapshots rather than claiming full SQLite compatibility.

Before publication, CI was corrected to preserve failures through `tee`, and its MoonBit toolchain was aligned to `0.10.21+06da1ed44`. Vite development builds now coalesce saves for 100 ms so an immediate SQL correction is not lost inside the watcher's throttle window. Both fixes have regression tests. Failed or cancelled earlier CI attempts are not counted as passing evidence.

## npm

Both `@mizchi/sqlike@0.2.0` and `@mizchi/litestream@0.2.0` are published as `latest`. Publication used GitHub Actions OIDC through `npm-release.yml`.

The [publishing workflow](https://github.com/mizchi/sqlike/actions/runs/44576013590/attempts/2) passed on attempt 2. Attempt 1 accepted both publications, but its immediate registry consumer received 404 during asynchronous propagation. After metadata, tarballs and attestations became available, attempt 2 verified the existing versions and skipped publishing before passing anonymous consumers. No version was republished and the tag was not changed.

The exact checked archives are retained in Actions artifact `npm-v0.2.0-1` (ID `14555394222`, SHA-256 `9728ae524c91f7201f472e7b1fef53ee744ca58fed513f2b50d602fcdddcf679`). Both registry tarballs match these archives byte for byte. Their SRI, provenance subject SHA-512, workflow/tag and source commit match. `npm audit signatures` verified registry signatures and attestations for both released packages and their `@noble/hashes` dependency.

Anonymous registry consumers passed Node, strict types, native SQLite queries, Chromium IndexedDB/offline reopening, Wasm GC and Drizzle migrations/prepared queries. An additional registry-installed Vite consumer generated a catalog-selected engine, checked query types and exercised prepared/image/transaction APIs. [npm verification](../../measurements/npm-registry-0.2.0.json).

## Mooncakes and release assets

`mizchi/sqlike@0.2.0` and `mizchi/litestream@0.2.0` are public and latest. Anonymous metadata and ZIP downloads matched the checked dry-run archives exactly. Standalone registry consumers passed on JS and Wasm GC. [Mooncakes verification](../../measurements/moon-registry-0.2.0.json).

All ten GitHub Release assets were downloaded anonymously and matched their local bytes, sizes and GitHub SHA-256 digests. They include both npm tarballs, both Mooncakes ZIPs, two checksum lists, npm/Mooncakes validation records, a release validation record and the current performance report. The complete verification record retains each asset URL and digest.

The [preparation record](release-0.2.0-preparation.md) describes the earlier local candidate. Its generated-file paths and local archive digests are historical; the published npm archives are the CI artifacts above. Remaining SQL gaps, advisory semantic-lint review and enhancement issues stay tracked in [TODO.md](../../TODO.md).
