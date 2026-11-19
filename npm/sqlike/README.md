# @mizchi/sqlike

A SQLite subset written in MoonBit for browsers and Node.js 24+. ESM; no MoonBit compiler or SQLite WASM is required at runtime. Unsupported SQL is rejected explicitly. SQLike does not implement every SQLite feature.

```sh
pnpm add @mizchi/sqlike@0.2.0
```

```js
import { openDatabase } from '@mizchi/sqlike';

const db = openDatabase();
db.run('CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT)');
db.run('INSERT INTO task VALUES(?,?)', [1n, 'hello']);
console.log(db.values('SELECT id,title FROM task')); // [[1n, 'hello']]
const image = db.dump();
db.close();
const reopened = openDatabase(image);
reopened.close();
```

INTEGER values use `bigint`, REAL uses `number`, and BLOB uses `Uint8Array`. `all()` returns objects keyed by column name; `values()` preserves column positions, including duplicate names. Ordinary connections keep rows in memory. Use images or the IndexedDB path below for persistence.

## Choose an engine

The default entry provides baseline SQL: CRUD, RETURNING, JOINs, aggregates, indexes, transactions, FK and STRICT. Use `@mizchi/sqlike/full` for all implemented SQL features, including JSON, CTEs, triggers and windows.

When upgrading from 0.1.2, change imports that need those features:

```js
import { openDatabase } from '@mizchi/sqlike/full';
```

`@mizchi/sqlike/aot` executes build-time compiled named statements without the SQL parser on JS and Wasm GC. Its portable ABI uses Cell JSON. `/aot/native` provides JS-only typed bindings and results. Import one prebuilt engine per application to avoid duplicated runtimes. Engine-free hosts in `/aot/core` support custom runtime injection.

For execute-only portable AOT builds, select `apiCapabilities: []` and use `openAotExecutor(runtime, program)` from `/aot/core`; adapt Wasm exports with `aotExecutorWasm(instance.exports)`. This exposes `execute` and `close`, retaining statement atomicity. The standard portable engine keeps its prepared, image, transaction and delta APIs. [AOT APIs](https://github.com/mizchi/sqlike/blob/main/docs/native-aot.md) · [Build targets](https://github.com/mizchi/sqlike/blob/main/docs/build-targets.md).

## Compile SQL files with Vite

```js
// vite.config.js
import { sqlikeAot } from '@mizchi/sqlike/vite';

export default {
  plugins: [sqlikeAot({
    include: 'src/client/**/*.sql',
    schemaFiles: 'src/schema.sql',
  })],
};
```

Browser code imports `openDatabase` and `queries` from `@mizchi/sqlike/aot`. The plugin infers features from SQL files and generates a JS engine, query types and size reports. Changes, additions and deletions rebuild the catalog. Mixing dynamic SQL or another prebuilt engine into that AOT build fails with an import diagnostic.

The build requires Node.js 24+, Vite 8 and the MoonBit CLI on PATH (tested toolchain: `0.10.21+06da1ed44`). The compiler and build sources stay outside the browser bundle. [Vite AOT guide](https://github.com/mizchi/sqlike/blob/main/docs/vite-aot.md).

## Binary catalogs and IndexedDB

Compile the schema and queries once in a Node.js build step:

```js
import { buildDefinedCatalog } from '@mizchi/sqlike/compiler';

const catalog = buildDefinedCatalog({
  schema: ['CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT)'],
  queries: [
    { name: 'add', sql: 'INSERT INTO task VALUES(?,?)' },
    { name: 'list', sql: 'SELECT id,title FROM task ORDER BY id' },
  ],
});
```

Pass the generated `schema` and `statements` byte arrays and `manifest` to the application as data. The compiler uses `node:sqlite` and is not a browser dependency.

```js
import { DefinedDatabase } from '@mizchi/sqlike/defined';

const db = await DefinedDatabase.open('tasks', catalog);
await db.execute('add', [1n, 'hello']);
console.log(await db.prepare('list').all());
await db.close();
```

Reopening restores IndexedDB data. `DefinedDatabase.memory(catalog)` disables persistence; `withStore(catalog, store)` accepts another provider. A mismatched saved schema ID is rejected; migration is application-managed. Query execution still retains row data in memory.

`analyzeCatalogRequirements(source)` infers fixed-catalog capabilities. Custom builds can omit unused functions, statements, expressions and SELECT structures. Inject a generated binary runtime through `createDefinedDatabase(runtime)` from `/defined/core`. [Catalog builds](https://github.com/mizchi/sqlike/blob/main/docs/catalog-build.md).

## Optional entries

| Import | Purpose |
| --- | --- |
| `@mizchi/sqlike/full` | Dynamic SQL with all implemented features |
| `@mizchi/sqlike/aot` | Portable prepared named statements; also the Vite plugin's generated catalog import |
| `@mizchi/sqlike/aot/core` | Engine-free portable/native AOT hosts and Wasm adapters |
| `@mizchi/sqlike/aot/native` | JS-only typed AOT engine |
| `@mizchi/sqlike/runtime` | Custom JS/Wasm injection through `openSql` and `openCompiled` |
| `@mizchi/sqlike/defined/core` | Engine-free binary catalog host and types |
| `@mizchi/sqlike/defined/sqlite` | SQLite image export for catalogs built with `sqliteExport: true` |
| `@mizchi/sqlike/defined/wasm` | `definedWasm` adapter for Wasm GC exports |
| `@mizchi/sqlike/features` | Build-time feature profiles; no engine |
| `@mizchi/sqlike/pager` | Optional incremental SQLite page export and page stores |
| `@mizchi/sqlike/drizzle` | Drizzle adapter, int64/bytes column types and migration readers |
| `@mizchi/sqlike/drizzle/node` | Node filesystem migration reader |
| `@mizchi/sqlike/drizzle/compiler` | Build-time Drizzle query compilation |
| `@mizchi/sqlike/drizzle/prepared` | Named-placeholder execution without Drizzle or the SQL parser |
| `@mizchi/sqlike/engine` | Low-level baseline MoonBit JS ABI; handle internals are private |

Drizzle users install `drizzle-orm@0.45.4` separately. Wasm assets are available under `/wasm/sql.wasm`, `/wasm/full.wasm`, `/wasm/aot.wasm` and `/wasm/defined.wasm`. They require Wasm GC, JS string builtins and the matching host adapter.

Synchronization is provided separately by `@mizchi/litestream`. FTS and experimental LSM implementations are excluded from this npm package. [Supported SQL](https://github.com/mizchi/sqlike/blob/main/docs/sql.md) · [Persistence](https://github.com/mizchi/sqlike/blob/main/docs/prepared.md) · [Migration notes](https://github.com/mizchi/sqlike/blob/main/docs/releases/v0.2.0.md). MIT.
