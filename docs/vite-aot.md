# Compile SQL files with Vite

The Vite plugin scans SQL files, compiles their schema and named statements, and builds one JS engine containing the required SQL features. Add JSON, date/time, CTE or other supported SQL to the catalog and the next build includes the corresponding implementation. Remove it and the implementation can be omitted again. The browser receives a precompiled catalog and a parser-free engine.

Available in `@mizchi/sqlike@0.2.0`. Node 24+, Vite 8 and the MoonBit CLI (`moon` on PATH) are required on the build machine. The tested MoonBit toolchain is `0.10.21+06da1ed44`; older versions lack the JSON decoding API used by the compiler. The first compiler invocation may resolve MoonBit dependencies. Browsers need no compiler or build tools.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { sqlikeAot } from '@mizchi/sqlike/vite';

export default defineConfig({
  plugins: [sqlikeAot({
    include: 'src/client/**/*.sql',
    schemaFiles: 'src/schema.sql',
  })],
});
```

```sql
-- src/schema.sql
CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
```

```sql
-- src/client/notes.sql
-- name: add :exec
INSERT INTO notes(id, title) VALUES (?, ?);

-- name: get :one
SELECT id, title FROM notes WHERE id = ?;
```

```ts
// src/main.ts
import { openDatabase, queries } from '@mizchi/sqlike/aot';

const db = openDatabase();
db.execute(queries.add, [1n, 'Offline note']);
console.log(db.execute(queries.get, [1n]).rows);
db.close();
```

`openDatabase()` creates an in-memory executor with `execute()` and `close()`. It uses the four-export engine API and retains SQL statement atomicity. Parameters and results use the usual SQLike values: `bigint`, finite `number`, `string`, `Uint8Array` and `null`. SQL is compiled at build time; runtime values go through bound parameters.

For prepared SELECT handles, snapshot/restore and synchronous host transactions, choose `api: 'connection'`:

```ts
// Plugin option: sqlikeAot({ ..., api: 'connection' })
import { openDatabase, queries } from '@mizchi/sqlike/aot';

const db = openDatabase('', { clock: () => Date.now() });
db.execute(queries.add, [1n, 'Offline note']);
const statement = db.prepare(queries.get);
console.log(statement.get([1n]));
const image = db.dump();
db.restore(image);
db.transaction(() => db.execute(queries.add, [2n, 'Another note']));
statement.finalize();
db.close();
```

This API adds the prepared, snapshot and transaction capabilities to the generated engine. It uses the portable prepared-handle host and does not include the SQL parser. IndexedDB publication and application migrations remain caller-owned; the plugin does not automatically persist or migrate databases.

## SQL selection and names

- One plugin instance owns the catalog for a Vite configuration. Combine multiple folders with an `include` array.
- `include` defaults to `src/client/**/*.sql`. `src/client/*.sql` selects only that directory. Patterns are relative to Vite's resolved root; `exclude` removes matched paths.
- A file containing one unnamed statement uses its basename as the query name: `get.sql` becomes `queries.get`.
- Multiple statements in a query file each need a `-- name: queryName` header. Optional sqlc-style tags such as `:one`, `:many` and `:exec` are accepted as metadata; `execute()` still returns its standard result object.
- Headers are recognized in leading comments, not inside quoted SQL or trigger bodies. Duplicate names across files are errors. Comment-only files contribute no queries.
- `schema` supplies an ordered array of DDL strings. `schemaFiles` supplies globs for SQL schema files. Inline schema runs first, then schema files in sorted path order, preserving statement order within each file. Schema files are removed from the query set if globs overlap.
- Every selected query contributes to feature inference, including queries that application JS never calls. Remove or exclude unused SQL files to remove their requirements. Include patterns select catalogs; direct imports of `.sql` files are not required.
- Invalid or unsupported SQL fails compilation. An empty query set fails instead of silently selecting an all-features runtime.

## Generated types and reports

The plugin writes `src/sqlike-aot.generated.d.ts` after a successful compilation. Include that file in your TypeScript project. The `@mizchi/sqlike/aot` module has literal query names, the selected host API, and these exports:

| Export | Value |
| --- | --- |
| `openDatabase` | Create an executor or connection, according to `api` |
| `queries` | Frozen mapping from query names to their string keys |
| `artifact` | Compiled program definition |
| `runtime` | The single selected engine namespace |
| `metadata` | Requirements, exports, fingerprints and byte counts |

Set `dts` to another relative `.d.ts` path, or `false` to disable generation. Existing files without the plugin's generated-file header are not overwritten. Type generation is part of the Vite build, so run Vite once before a separate typecheck on a clean checkout.

Production builds emit `sqlike-aot-report.json`. Set `reportFile` to another relative JSON path, or `false` to disable it. `runtimeBytes` is the OXC-minified engine size before the application's final tree shaking or compression; `artifactBytes` is the compiled program's UTF-8 size. These are not the size of the whole application bundle. The report also lists inferred function groups, features, statement/query kinds and the selected engine exports.

`primaryKeyIndex` defaults to `true` for indexed key access. Set it to `false` to trade that optimization for size. Optimizers are selected from the catalog by default; `optimizers: []` disables the optional shortcuts while retaining the catalog's SQL semantics. Feature requirements are inferred from compiled SQL and schema, including defaults, indexes, views and triggers.

Catalog selection also trims JSON/binary expression decoders, preparation and evaluation for unused function calls, subqueries, CAST, CASE and BETWEEN. Schema expressions and unused branches contribute to selection. GROUP BY is tracked separately from aggregate functions, so grouping without `count`, `sum` or similar functions keeps its required implementation.

Unused FK and trigger readers are excluded. FROM sources, final ORDER BY, SELECT DISTINCT and LIMIT/OFFSET are selected from the catalog too. Window ordering remains independent of final result ordering. Loading a catalog that needs an omitted capability fails when opening the database. Queries without FROM also omit table access optimizer code while keeping the default plugin settings. [Minimum-size measurements and remaining work](internal/aot-compact-size.md) distinguish the engine, host and catalog sizes.

## Reject mixed runtime modes

Enabling `sqlikeAot()` makes that Vite build AOT-only. A runtime import of the baseline `@mizchi/sqlike`, `/full`, `/engine`, `/runtime`, compiler entries or another prebuilt engine fails with `SQLIKE_AOT_MIXED_MODE`. The diagnostic names the incompatible entry and importer. The check also covers re-exports, literal dynamic imports, aliases to package entry files, and external modules in production builds. SQLike is excluded from dependency pre-bundling so the guard can inspect its entries.

Engine-free helpers remain available: `/aot/core`, `/defined/core`, `/defined/wasm`, `/drizzle/prepared`, `/features`, `/pager`, and `/package.json`. Erased `import type` declarations do not introduce a runtime and are allowed. Imports used only by `vite.config.ts` run outside the application module graph, so build-time compiler usage remains possible. To use dynamic SQL, build it separately without `sqlikeAot()`.

In dev, a mixed import displays Vite's error overlay. Removing it restores the AOT application. Production builds exit with an error instead of shipping both runtimes.

## Development, watch and caching

SQL changes, additions and deletions trigger recompilation and a full page reload. In-memory data is reset by that reload. Invalid edits display Vite's error overlay; restoring valid SQL clears it, including when restored to the previous catalog.

`vite build --watch` also follows new and deleted query files. The engine is stored below Vite's `cacheDir/sqlike-aot`. Queries are recompiled when SQL changes, but the engine is reused when its selected capabilities and compiler inputs stay the same. Adding JSON can select a new engine; a change to a literal or query name alone can reuse the existing engine. Each reused engine is checked against its SHA-256 seal. Cache identity includes MoonBit sources, the build implementation and tool versions. An edit during compilation is detected before publishing the client/types, with bounded retries.

`@mizchi/sqlike/vite` is a Node-only entry. Its MoonBit sources are distributed under `dist/build-sources`, independently of runtime entries. Normal browser entries do not import the plugin, compiler or these source assets. With the plugin enabled, an exact import of `@mizchi/sqlike/aot` resolves to the generated catalog and selected engine. The generated `.d.ts` describes that catalog-bound API. The `@mizchi/sqlike/aot/core` subpath remains available to the generated host. Without the plugin and its generated declarations, `@mizchi/sqlike/aot` provides the existing prebuilt `openAotDatabase(artifact, ...)` API.

Repository validation:

```sh
just vite-aot-check
```

The checks use real Vite production/dev/watch builds, Chromium, and a tarball installed outside the workspace. They verify CRUD, JSON-driven engine growth, cache reuse, file additions/deletions, invalid-query recovery, mixed-mode rejection and recovery, generated types, prepared handles, rollback and image restore. Compiler code and SQL parser functions are rejected from the produced browser JS.
