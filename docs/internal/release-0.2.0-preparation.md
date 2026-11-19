# 0.2.0 release preparation

Prepared on November 20, 2026. This is a local release candidate, **not a publication record**. No release tag or registry publication has been performed as part of this preparation.

Publication subsequently completed. See the [0.2.0 publication verification](release-0.2.0-verification.md) for final CI, registry consumers, provenance and release assets. The candidate's generated paths and local archive digests below are historical.

## Scope and version

The proposed version is 0.2.0 because the default SQLike entry becomes the smaller baseline. Existing applications using JSON, CTEs, triggers or windows must move to `/full`. The English release notes include npm/MoonBit migration examples and the supported-format boundary.

The private root workspace, both npm packages, both MoonBit modules and the AOT example use 0.2.0. The release version checker first rejected `v0.2.0` against 0.1.2, then accepted the aligned candidate. The external entry-point test now uses the workspace version rather than a fixed 0.1.2 dependency.

Issue #7, #8 and #9 have English titles/bodies and retain the `enhancement` label. The root, npm/Mooncakes package, user-guide index and AOT example READMEs use English. The Japanese root README and historical internal/fixture documentation are retained.

## Verification status

| Check | Status |
| --- | --- |
| Frozen pnpm installation and MoonBit dependency update | Passed |
| npm/tag version consistency for `v0.2.0` | Passed |
| Fresh P0 measurements and report hashes | Passed: `just p0-measure`, then `just p0-check`; source and artifact hashes verified |
| Native SQLite, JS/Wasm, Node, Chromium, types and differential/output gates | Passed: 96 MoonBit tests per target, 582 Node tests, 73 Chromium tests and both audit gates |
| Current engine sizes, README figures and graph proof | Passed: minimum/CRUD/entry/browser reports refreshed; both README tables and figures regenerated; 8 Z3 obligations passed for 125 nodes and 160 dependency edges |
| Exact npm tarballs and independent consumers | Passed: both 0.2.0 tarballs, including Node/types/Chromium/Wasm/Vite consumers |
| Mooncakes dry-run ZIPs and independent JS/Wasm consumers | Passed: 159 SQLike files and 18 Litestream files; metadata, licenses and external consumers verified |
| npm login and current Trusted Publishing settings | Passed after browser 2FA: account `mizchi`; both packages allow publication from `mizchi/sqlike` / `npm-release.yml` |
| Fresh Linux CI on the final release commit | Pending commit/PR |
| Semantic-lint residual candidate review | Remains tracked in TODO; no claim that all semantic findings are resolved |

The differential audit covered 601 cases and 3,606 results in each of Node and Chromium: 3,598 matches, four AOT compile rejections and four inapplicable cases, with zero failing checks. The broader SQLite feature inventory observed 508 matching probes and 230 atomic rejections per target, with no value mismatches; unverified and unsupported inventory remains. These checks establish the documented subset, not universal SQLite compatibility.

The browser-size comparison now measures the full SQL entry on both JS and Wasm GC. A JSON/CTE/window probe first failed against the baseline JS entry, then passed after selecting `/full`. All ten exact minified browser asset sets were executed. Current 5,000-row comparisons and catalog sizes were refreshed; the 100,000-row chart and focused optimization experiments remain explicitly dated historical snapshots.

The [local evidence manifest](../../measurements/release-preparation-0.2.0.json) records artifact digests and the source revision before committing. npm archives are in `generated/npm/`; Mooncakes dry-run archives and `SHA256SUMS` are in `_build/publish/`. Generated archives must be rebuilt and rechecked if their source or public README changes.

### CI correction before publication

The first [PR #10 CI run](https://github.com/mizchi/sqlike/actions/runs/44570756880) displayed successful jobs while their logs contained compiler errors. The implicit shell allowed `tee` to hide upstream failures. This run is **not passing validation evidence**. CI now selects explicit Bash with pipefail; a regression test first reproduced exit 0 for a deliberate failing check, then verified exit 17 and retained logs for all four pipelines.

The old CI toolchain lacked the `DecodeContext` API. Both CI and npm publishing now pin the locally tested `0.10.21+06da1ed44` toolchain and print its complete version. The additional regression test and typecheck passed. Public toolchain instructions were corrected, both package formats were rebuilt, and six npm checks plus the two independent JS/Wasm Mooncakes consumers passed again. Database implementation and benchmark sources did not change. A fresh Linux run remains required before tagging.

The next [Linux run](https://github.com/mizchi/sqlike/actions/runs/44571788682) passed types, dependency graphs and browser checks, but its Node job correctly failed on Vite SQL error recovery. Chokidar can suppress a corrective save inside its 50 ms change-event throttle window. A deterministic test reproduced the missing recovery reload before the fix. The plugin now coalesces saves for 100 ms before compiling, and cancels its timer on close. The existing real-browser recovery test and the new immediate-repair test passed, together with all 12 Vite/CI regression checks, six repacked npm checks and typecheck. The browser engine and measured query implementations remain unchanged; the final Linux run must include this plugin fix.

## Registry and OIDC status

An anonymous npm metadata check found 0.1.2 as `latest` for both `@mizchi/sqlike` and `@mizchi/litestream`; 0.2.0 was absent. This preparation does not publish either package.

The existing tag-triggered `.github/workflows/npm-release.yml` remains the OIDC publishing route. Its workflow filename and repository match the recorded trusted publisher configuration, and it checks package/tag versions and independent packed consumers before publishing.

After the user logged in, `npm whoami` confirmed the `mizchi` account. npm required an additional browser 2FA challenge for the first trust-setting read; that challenge completed successfully. Fresh `npm trust list <package> --json` requests then verified both current configurations:

| Package | Provider | Repository | Workflow | Permissions |
| --- | --- | --- | --- | --- |
| `@mizchi/sqlike` | GitHub | `mizchi/sqlike` | `npm-release.yml` | Publish and stage publish |
| `@mizchi/litestream` | GitHub | `mizchi/sqlike` | `npm-release.yml` | Publish and stage publish |

Both configurations match the existing release workflow. The earlier HTTP 401 authentication failure is resolved. No trusted publisher settings were changed, and this check did not publish either package or validate a new OIDC publication.

## Before publication

Review and commit the complete candidate, including generated package sources and updated measurements. Run the four Linux CI jobs on that commit. Retain the exact checked npm tarballs/ZIPs and checksums, and verify the pending release-review items in TODO.

Tag creation/push, npm OIDC publication, Mooncakes publication, anonymous registry consumers, provenance and GitHub Release assets are publication steps. Record their actual results separately after they run. Do not reuse 0.1.2 publication evidence as proof that 0.2.0 has shipped.
