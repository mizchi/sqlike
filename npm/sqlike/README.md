# @mizchi/sqlike

MoonBit製のSQLiteサブセット。実行にMoonBitコンパイラやSQLite WASMは不要。ESM、Node.js 24以上と現行ブラウザ向け。SQLite全機能互換は未達で、対応範囲外は明示的に拒否する。

```sh
pnpm add @mizchi/sqlike@0.1.1
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

INTEGERは`bigint`、REALは`number`、BLOBは`Uint8Array`。`all()`は列名をキーとする行、`values()`は重複列名も保持する列位置順の行を返す。通常の接続はインメモリで、保存する場合はdumpまたは下記のIndexedDB経路を使う。

## パーサを含めない実行とIndexedDB

Node.jsのビルド処理でDDLと問い合わせを一度コンパイルする。

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

生成した`schema`・`statements`のUint8Arrayと`manifest`をデータとしてアプリへ渡す。compilerは`node:sqlite`を使い、ブラウザへ配信しない。

```js
import { DefinedDatabase } from '@mizchi/sqlike/defined';
const db = await DefinedDatabase.open('tasks', catalog); // ブラウザのIndexedDB
await db.execute('add', [1n, 'hello']);
console.log(await db.prepare('list').all());
await db.close();
```

`DefinedDatabase.memory(catalog)`は保存なし。`withStore(catalog, store)`で保存先を差し替えられる。定義と保存schemaIdが違う場合は拒否し、自動migrationしない。SQL JSON / 日時 / window等を省いた独自生成ランタイムは`/defined/core`の`createDefinedDatabase(runtime)`へ渡す。機能選択ビルドのツールはリポジトリに含む。

0.1.1では、`@mizchi/sqlike/compiler`の`analyzeCatalogRequirements(source)`で固定catalogの必要機能を解析できる。リポジトリのビルドツールへcatalogを渡すと、未使用の関数群・文・JOIN・CTE・複合SELECT・JSON処理を除去する。[ビルド方法と制限](https://github.com/mizchi/sqlike/blob/v0.1.1/docs/catalog-build.md)を参照。

## 任意のentry

| import | 用途 |
| --- | --- |
| `@mizchi/sqlike/runtime` | `openSql` / `openCompiled`への独自JS / Wasmランタイム注入。既定engineを読み込まない |
| `@mizchi/sqlike/defined/core` | engineを読み込まない固定schemaのhostと型 |
| `@mizchi/sqlike/defined/sqlite` | `sqliteExport: true`で作ったcatalogとsnapshotのSQLite画像出力 |
| `@mizchi/sqlike/defined/wasm` | Wasm GCのexportを`DefinedRuntime`へ変換する`definedWasm` |
| `@mizchi/sqlike/features` | ビルド時の機能プロファイル。engineを読み込まない |
| `@mizchi/sqlike/drizzle` | `drizzle`、`sqliteInt64`、`sqliteBytes`、データ形式のmigration reader |
| `@mizchi/sqlike/drizzle/node` | ディレクトリから読むNode用migration reader |
| `@mizchi/sqlike/drizzle/compiler` | Drizzle query builderを固定catalogへ変換するNode用compiler |
| `@mizchi/sqlike/drizzle/prepared` | DrizzleやSQL parserを含めず、named placeholderで登録済みqueryを実行 |
| `@mizchi/sqlike/engine` | 低水準のMoonBit JS ABI。handleの内部表現は非公開 |

Drizzleを使う場合は`drizzle-orm@0.45.4`を追加し、`drizzle(openDatabase())`へ渡す。`wasm/defined.wasm`・`wasm/sql.wasm`も同梱する。Wasm GCは`js-string` / `_`のstring constantを指定してinstantiateし、固定schemaでは`definedWasm(instance.exports)`を使う。

同期は独立した`@mizchi/litestream`。FTSと実験的LSMはこのnpmパッケージに含めない。[全体の対応表](https://github.com/mizchi/sqlike/blob/main/docs/sql.md)と[バイナリ定義](https://github.com/mizchi/sqlike/blob/main/docs/prepared.md)を参照。MIT。
