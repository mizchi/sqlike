# SQLike

ブラウザやNode.jsでSQLを実行できる、MoonBit製のSQLiteサブセットです。インメモリDBとして使うほか、あらかじめ定義したSQLをIndexedDBへ保存しながら実行できます。同期には独立した `@mizchi/litestream` を組み合わせます。

## できること

| 用途 | 提供する機能 |
| --- | --- |
| アプリ内のSQLデータベース | CRUD、JOIN、集約、RETURNING、transaction、index、FK、基本trigger |
| オフラインでの保存・再開 | 固定schemaとnamed statementを使うIndexedDB保存。接続やページを開き直して再開 |
| 配信する機能の選択 | SQLパーサを含まない実行、独自生成runtimeの注入、compiler・SQLite出力・Drizzleの別entry |
| Drizzleとの連携 | 型付きクエリ、RETURNING、migration、入れ子transaction |
| サーバーとの同期 | SQL / SQLite Session差分、再送、重複排除、利用側で記述する適用・競合policy |
| SQLite・LTXとの受け渡し | SQLite画像の書き出し、LTX v3の生成・適用 |

## インストール

JavaScript / TypeScript向けに、[SQLike](https://www.npmjs.com/package/@mizchi/sqlike)と[Litestream](https://www.npmjs.com/package/@mizchi/litestream)をnpmで公開しています。ESM、Node.js 24以上と現行ブラウザ向けです。実行にMoonBitコンパイラは不要です。

```sh
pnpm add @mizchi/sqlike
# 同期・LTXも使う場合
pnpm add @mizchi/litestream
```

[GitHub Releases](https://github.com/mizchi/sqlike/releases/tag/v0.1.0)にも配布用アーカイブを用意しています。

## SQLを実行する

```ts
import { openDatabase } from '@mizchi/sqlike';

const db = openDatabase();
db.run('CREATE TABLE task(id INTEGER PRIMARY KEY,title TEXT NOT NULL)');

const rows = db.values(
  'INSERT INTO task VALUES(?,?) RETURNING id,title',
  [1n, '買い物メモ'],
);
// [[1n, '買い物メモ']]

const tasks = db.all('SELECT id,title FROM task ORDER BY id');
// [{ id: 1n, title: '買い物メモ' }]

db.transaction(() => {
  db.run('UPDATE task SET title=? WHERE id=?', ['更新したメモ', 1n]);
});
db.close();
```

`openDatabase()`はインメモリです。INTEGERは`bigint`、REALは`number`、BLOBは`Uint8Array`で扱います。`values()`は列位置順の配列、`all()`は列名をキーとするオブジェクトを返します。同名の結果列がある場合は`values()`を使います。

[SQLの対応範囲と値の扱い](docs/sql.md)

## IndexedDBへ保存する

ブラウザで使うschemaと問い合わせが決まっている場合は、ビルド時にDDLとnamed statementをコンパイルできます。実行側はバイナリ定義を読み込み、SQLパーサを配信せずに動きます。

```ts
import { DefinedDatabase } from '@mizchi/sqlike/defined';
import { catalog } from './catalog.generated.js';

const db = await DefinedDatabase.open('tasks', catalog);
await db.execute('add', [1n, 'オフラインで書いたメモ']);
const tasks = await db.prepare('list').all();
await db.close();
```

同じ名前とcatalogで開き直すと、保存したデータを読み込みます。保存先は差し替え可能です。保存データと異なるschemaを自動で読み替えることはありません。

[catalogの作成・永続化・SQLite出力](docs/prepared.md)

## Drizzleを使う

```sh
pnpm add drizzle-orm@0.45.4
```

```ts
import { openDatabase } from '@mizchi/sqlike';
import { drizzle } from '@mizchi/sqlike/drizzle';

const client = openDatabase();
const db = drizzle(client);
```

Drizzleは任意のentryです。通常のSQLや固定schemaの実行だけなら追加は不要です。

[テーブル定義・migration・transaction](docs/drizzle.md)

## 同期・LTXを使う

`@mizchi/litestream`はDBドライバーの契約を通じて同期します。SQLike・SQLite・Tursoとの構成例があり、Node、Cloudflare Durable Objects、P2Pリレーを正本や中継として使えます。利用できる同期方式は各driverの能力に依存します。

競合時には、利用側で適用・保留・拒否・置換を判断できます。LTXの生成・適用だけを使う場合は、`@mizchi/litestream/ltx`をimportします。

[同期の組み込み・競合処理・LTX](docs/sync.md)

## 利用上の制約

- ブラウザでの確認対象は現在Chromiumです。
- SQLite全機能互換ではありません。SQL・関数・PRAGMAには対応範囲があります。
- IndexedDB保存を使う場合も、クエリの実行中は行データをメモリに保持します。
- 固定schemaの実行では、実行時の任意DDLやschema変更の自動migrationは扱いません。
- 同期先の認証・認可、driverの選択、競合時の業務判断はアプリ側で用意します。

## MoonBitから使う

Mooncakesの2モジュールを単独で使えます。

```sh
moon add mizchi/sqlike@0.1.0
moon add mizchi/litestream@0.1.0
```

[SQLikeのAPI](packages/sqlike/README.md) / [LitestreamのAPI](packages/litestream/README.md)

MIT License。[リリース](https://github.com/mizchi/sqlike/releases) / [ユーザー向けガイド](docs/README.md) / [開発者向けドキュメント](docs/internal/README.md)
