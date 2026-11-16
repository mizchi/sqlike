# 事前定義したSQLとIndexedDB

schemaと問い合わせを事前に定義すると、ブラウザへSQLパーサを含めずに配信できます。実行側はcatalogの名前で問い合わせを選びます。

未リリースの現行ソースでは、同じcatalogから[必要な関数群・文の実装を自動選択するビルド](catalog-build.md)も使えます。

## ビルド時にcatalogを作る

Node.js 24以上で実行する`build-catalog.mjs`を用意します。

```js
import { writeFileSync } from 'node:fs';
import { buildDefinedCatalog } from '@mizchi/sqlike/compiler';

const catalog = buildDefinedCatalog({
  schema: ['CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT NOT NULL)'],
  queries: [
    { name: 'add', sql: 'INSERT INTO task VALUES(?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title' },
    { name: 'list', sql: 'SELECT id,title FROM task ORDER BY id' },
  ],
});

const fields = ['schema', 'statements', ...(catalog.storage ? ['storage'] : [])]
  .map(name => `${name}:new Uint8Array(${JSON.stringify([...catalog[name]])})`);
writeFileSync('catalog.generated.js',
  `export const catalog={${fields.join(',')},manifest:${JSON.stringify(catalog.manifest)}};\n`);
writeFileSync('catalog.generated.d.ts',
  "import type { DefinedCatalog } from '@mizchi/sqlike/defined'; export declare const catalog: DefinedCatalog;\n");
```

```sh
node build-catalog.mjs
```

`catalog.generated.js`はデータだけを含みます。compilerはビルド処理で使い、アプリの実行用entryからはimportしません。

## ブラウザで開く

```ts
import { DefinedDatabase } from '@mizchi/sqlike/defined';
import { catalog } from './catalog.generated.js';

const db = await DefinedDatabase.open('tasks', catalog);
await db.execute('add', [1n, 'hello']);
const rows = await db.prepare('list').all();
await db.close();
```

`open()`はIndexedDBへ保存します。同じ名前・schemaのcatalogで開き直すと再開できます。DB名は英数字・`_`・`-`の1〜56文字です。SharedArrayBufferやcross-origin isolationは不要です。

保存なしなら`DefinedDatabase.memory(catalog)`、独自の保存先を使うなら`DefinedDatabase.withStore(catalog, store)`を使います。保存先は`ImageStore`契約に従い、世代の検査と原子的なcommitを提供します。

## 実行と再開

- `execute(name, params?)`は列名・行・変更件数を返すPromise。
- `prepare(name).all(params?)`は列位置順の二次元配列。
- `prepare(name).get(params?)`は先頭行、または`undefined`。
- `snapshot()`は再開用のバイナリ画像。
- `close()`は未完了の処理を待って接続を閉じるPromise。

INTEGERは`bigint`、REALは`number`、BLOBは`Uint8Array`です。SQL文字列を実行するAPIではなく、登録していない問い合わせ名は拒否します。複数文をtransactionへまとめる場合は、BEGIN / COMMIT / ROLLBACKもcatalogへ登録します。

```ts
const source = await DefinedDatabase.open('tasks', catalog);
const image = await source.snapshot();
await source.close();
const restored = await DefinedDatabase.memory(catalog, { image });
await restored.close();
```

保存schemaIdが異なるcatalogは拒否します。DDLを変更する場合は利用側でデータ移行を用意します。同じschemaへの問い合わせの追加・変更は、既存データを使って開けます。

## SQLiteファイルへ書き出す

catalogの生成時に`buildDefinedCatalog(source, { sqliteExport: true })`を指定します。上記の生成コードは任意の`storage`も出力します。

```ts
import { exportDefinedSQLite } from '@mizchi/sqlike/defined/sqlite';
const source = await DefinedDatabase.open('tasks', catalog);
const sqliteImage = await exportDefinedSQLite(catalog, await source.snapshot());
await source.close();
```

この`Uint8Array`をSQLiteファイルとして保存したり、LTXの生成へ渡したりできます。`snapshot()`自体はSQLikeの保存形式で、SQLite画像とは異なります。

## 独自runtime・Wasm

`@mizchi/sqlike/defined/core`の`createDefinedDatabase(runtime)`は既定engineを読み込みません。機能選択ビルドで生成した独自のruntimeを渡せます。機能選択のビルドツールはリポジトリから利用します。

Wasm GCには`wasm/defined.wasm`と`@mizchi/sqlike/defined/wasm`の`definedWasm()`を使います。instantiate時には`builtins: ['js-string']`と`importedStringConstants: '_'`を指定します。

## Drizzleからcatalogを作る（未リリース）

Drizzleの`toSQL()`で列挙したクエリも事前コンパイルできます。ビルド時の`@mizchi/sqlike/drizzle/compiler`と、ORMを読み込まない`@mizchi/sqlike/drizzle/prepared`を分けています。[手順・placeholder・結果の型](drizzle-prepared.md)を参照してください。
