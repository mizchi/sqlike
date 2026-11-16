# Drizzleのクエリを事前コンパイルする

0.1.0以後の未リリース機能。Drizzle 0.45.4のquery builderで固定クエリを作り、SQLikeのバイナリcatalogへ変換できる。ブラウザにはDrizzle・SQL parser・compilerを配信せず、登録したクエリ名とplaceholderの値を渡して実行する。

## ビルド時

`@mizchi/sqlike/drizzle/compiler`はNode専用entry。`toSQL()`が返したSQLを解析し、定数とplaceholderの配置・標準encoderをデータとして保存する。

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';
import { openDatabase } from '@mizchi/sqlike';
import { drizzle } from '@mizchi/sqlike/drizzle';
import { compileDrizzleCatalog } from '@mizchi/sqlike/drizzle/compiler';

const tasks = sqliteTable('tasks', {
  id: integer().primaryKey(),
  title: text().notNull(),
});
const client = openDatabase();
const orm = drizzle(client);
const compiled = compileDrizzleCatalog({
  schema: ['CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT NOT NULL)'],
  queries: [
    { name: 'add', query: orm.insert(tasks).values({
      id: sql.placeholder('id'), title: sql.placeholder('title'),
    }).returning() },
    { name: 'get', query: orm.select().from(tasks)
      .where(eq(tasks.id, sql.placeholder('id'))) },
  ],
});
await mkdir('src/generated', { recursive: true });
await writeFile('src/generated/tasks.schema.bin', compiled.catalog.schema);
await writeFile('src/generated/tasks.statements.bin', compiled.catalog.statements);
await writeFile('src/generated/tasks.manifest.json', JSON.stringify(compiled.catalog.manifest));
await writeFile('src/generated/tasks.bindings.json', JSON.stringify(compiled.bindings));
client.close();
```

query builderへ渡した定数はビルド時の値で固定する。実行ごとに変わる値には`sql.placeholder()`を使う。列の定義だけではDBを作成しないため、最終schemaのDDLも明示する。

## ブラウザでの実行

```ts
import { DefinedDatabase } from '@mizchi/sqlike/defined';
import { openDrizzlePrepared } from '@mizchi/sqlike/drizzle/prepared';

const load = async (url: URL) => {
  const response = await fetch(url);
  if (!response.ok) throw Error(`catalog fetch failed: ${response.status}`);
  return response;
};
const [schema, statements, manifest, bindings] = await Promise.all([
  load(new URL('./generated/tasks.schema.bin', import.meta.url)).then(r => r.arrayBuffer()),
  load(new URL('./generated/tasks.statements.bin', import.meta.url)).then(r => r.arrayBuffer()),
  load(new URL('./generated/tasks.manifest.json', import.meta.url)).then(r => r.json()),
  load(new URL('./generated/tasks.bindings.json', import.meta.url)).then(r => r.json()),
]);
const db = await openDrizzlePrepared(DefinedDatabase, {
  catalog: { schema: new Uint8Array(schema), statements: new Uint8Array(statements), manifest },
  bindings,
});
await db.execute('add', { id: 1n, title: 'hello' });
const row = await db.prepare('get').get({ id: 1n }); // [1n, 'hello']
```

`prepare(name)`は`execute(values?)` / `all(values?)` / `get(values?)`を返す。結果はSQLikeの列位置順の`Value[]`で、INTEGERは`bigint`。Drizzleの列decoderや`mapWith()`は実行しない。アプリで必要な結果変換を明示する。

## 値と保存

| 入力 | 扱い |
| --- | --- |
| 通常のplaceholder | `null` / `bigint` / 有限の`number` / `string` / `Uint8Array` |
| boolean列のencoder付きplaceholder | `boolean`を0 / 1へ変換 |
| timestamp / timestamp_ms列 | 有効な`Date`を秒 / ミリ秒へ変換。秒は負の時刻も切り下げ |
| JSON text列 | 標準の`JSON.stringify()`で変換 |
| 定数 | ビルド時のdriver値を型付きで保存。int64、BLOB、REALの負のゼロを保持 |

`toSQL()`にencoder付き`Param`として残ったplaceholderを変換する。raw SQLのplaceholderは通常の`Value`を受け取る。独自encoder・標準encoderの上書きはビルド時に拒否する。placeholderの不足・余分な名前・不正な値は書込前に拒否する。

binding planにはschemaId / programIdとSHA-256を含め、DBを開く前に対応するcatalogと内容を検査する。runtimeのfactoryを注入できるため、[選択ビルド・Wasm](prepared.md)も使用できる。

`{ name: 'tasks' }`を指定するとfactoryのIndexedDB保存を使い、同じ名前・catalogで開き直すと復元する。保存先の差し替えには`{ name, provider }`か`{ store }`を渡す。`snapshot()` / `close()`と、`{ image }`からの再開にも対応する。`name`・`store`・`image`は同時指定しない。IndexedDBの保存契約は[事前定義DB](prepared.md)と共通。

固定したDDLとクエリの実行用entryであり、実行中のquery builder・DDL・migrationは扱わない。動的なDrizzleとmigrationは[既存driver](drizzle.md)を使う。

## 検証とサイズ

[差分・ブラウザテスト](../tests/drizzle-defined.test.ts)はJS / Wasm、RETURNING、codec、plan破損、不正bind後の非変更、Chromiumの最小ビルドとsnapshot再開を検証する。ブラウザ生成物にDrizzle・compiler・SQL parserがないことも確認する。

任意adapter単体のminify後未圧縮 / Brotliは[計測JSON](../measurements/drizzle-defined-size-current.json)に記録する。注入するengine / host・catalog・binding planは別資産で、圧縮後の容量を単純加算した値ではない。

仕様参照: [DrizzleのSQLとparameter](https://orm.drizzle.team/docs/sql)、[prepared queryとplaceholder](https://orm.drizzle.team/docs/perf-queries)。
