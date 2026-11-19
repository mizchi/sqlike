# Prepared AOT statements

**Unreleased.** These entries are available in the source build after 0.1.2.

`@mizchi/sqlike/aot` executes precompiled named statements with typed bindings and positional results. It omits the SQL parser and uses a portable ABI shared by JavaScript and Wasm GC. The compiler runs at build time; the application receives a serialized Program. [`/aot/native`](#native-javascript-abi) is an optional JS-only fast path.

```js
// Build time, Node.js
import { writeFileSync } from 'node:fs';
import { buildCatalog } from '@mizchi/sqlike/compiler';

const { artifact } = buildCatalog({
  schema: ['CREATE TABLE item(id INTEGER PRIMARY KEY,n INTEGER)'],
  queries: [
    { name: 'add', sql: 'INSERT INTO item VALUES(?,?) RETURNING id' },
    { name: 'get', sql: 'SELECT n*2 AS doubled FROM item WHERE id=?' },
  ],
});
writeFileSync('program.generated.js', `export default ${JSON.stringify(artifact)};\n`);
```

```js
// Application, browser or Node.js
import { openAotDatabase } from '@mizchi/sqlike/aot';
import program from './program.generated.js';

const db = openAotDatabase(program);
db.execute('add', [1n, 21n]);
const get = db.prepare('get');
console.log(get.names);          // ['doubled']
console.log(get.values([1n]));   // [[42n]]
console.log(get.get([1n]));      // [42n]
const image = db.dump();
get.finalize();
db.close();
```

`execute(name, params)` handles named SELECT, DML, transaction and PRAGMA statements supported by the Program, and returns `{ names, rows, readonly, changes }`. `prepare(name)` provides reusable SELECT handles. `values(name, params)` caches those handles with a connection-local LRU, default 64 and maximum 256; set `statementCacheCapacity: 0` to disable it. Explicit `prepare()` handles have caller-owned lifetimes. Finalization is idempotent, and `close()` releases all handles and the connection reference.

Bindings use `null | bigint | number | string | Uint8Array`. BigInt must fit signed int64. Numbers bind as REAL, including integral numbers and negative zero; NaN and infinity bindings are rejected. Strings must be well-formed UTF-16. BLOB inputs and outputs are copied, including Buffer and subarray inputs. Results preserve INTEGER as BigInt, REAL as number, duplicate column positions, NUL text, and BLOB bytes. SQL can produce infinite REAL results even though non-finite bindings are rejected.

The portable engine serializes bindings and results as Cell JSON while reusing prepared SELECT handles. Program loading, metadata, clock updates and snapshots also use JSON. Results are eager arrays; this API does not bound memory independently of result size.

`openAotDatabase(program, image, options)` accepts a prior `dump()` with the same Program/schema identity. `restore(image)` changes the live data read by existing handles. `transaction(() => ...)` is synchronous and rejects nesting and asynchronous results. On rollback, it discards raw prepared handles and prepares them again when next used; logical statement wrappers remain valid. Provide `options.clock: () => milliseconds` for a deterministic clock.

This connection is in memory. Applications can store and restore its image; automatic IndexedDB journaling remains available through the separate predefined database API.

For a catalog-selected JS or Wasm GC engine, inject it through an entry that imports no default engine:

```js
import * as runtime from './generated/runtime.js';
import { openPortableCompiled } from '@mizchi/sqlike/aot/core';
const db = openPortableCompiled(runtime, program);
```

For Wasm GC, instantiate with `builtins: ['js-string']` and `importedStringConstants: '_'`, then pass `aotWasm(instance.exports)` from `/aot/core`. [Build targets](build-targets.md) also cover MoonBit source output, baseline/full selection, optimizer selection, and dependency verification.

## Execute-only builds

A portable AOT profile with `apiCapabilities: []` exports just `aot_open`, `aot_info`, `aot_set_clock` and `aot_execute`. Inject it with `openAotExecutor(runtime, program)` from `/aot/core`, or use `aotExecutorWasm(instance.exports)` for Wasm GC. The connection exposes `execute(name, params)` and `close()`. Statement writes remain atomic, and query metadata stays prepared; snapshot, host transaction and reusable SELECT-handle methods are omitted. Result arrays are eager.

Omitting `apiCapabilities` keeps the existing 15-export ABI. To retain `openPortableCompiled` with snapshot, rollback and SELECT handles while omitting delta exports, select `['prepared', 'snapshot', 'transaction']`. Missing full-host functions are detected before opening a connection. [Configuration and the CRUD example](build-targets.md#aotの公開apiを選ぶ) describe each capability and the equivalent MoonBit source output. Capability selection currently applies to portable AOT; native AOT keeps its existing ABI.

## Native JavaScript ABI

`import { openAotDatabase } from '@mizchi/sqlike/aot/native'` provides the same connection API with native JS bindings and results. This path avoids Cell JSON for values; metadata and snapshots still use JSON. It is JS-only and includes an independent engine.

For a selected native engine, build with `nativeResults: true` and inject it as follows:

```js
import * as runtime from './generated/runtime.js';
import { openNativeCompiled } from '@mizchi/sqlike/aot/core';
const db = openNativeCompiled(runtime, program);
```

Importing the default SQL, portable AOT, predefined, or Litestream entry does not import the native engine. Prebuilt engines are independent: importing several in one app includes several MoonBit runtimes. Use one engine and the engine-free host entry when optimizing application size. [Catalog builds](catalog-build.md) describe feature selection; [measurements and compatibility tests](internal/performance-next.md) record the native implementation's scope.
