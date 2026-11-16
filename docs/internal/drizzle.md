# Drizzle・RETURNING・migration

2026-11-16、開発版0.0.1。`drizzle-orm@0.45.4` / `drizzle-kit@0.31.11`を固定し、同期SQLite driverを独立したentryとして追加した。Node SQLite、SQLike JS / Wasm GC、本家SQLite WASM、実workerd DOで検証する。Drizzleやmigration readerは既定のデモ・lite・Workerには含めない。

## 利用方法

```ts
import { MoonDatabase } from "../adapters/moon-database.ts";
import { drizzle } from "../adapters/drizzle.ts";
import { migrate } from "../adapters/drizzle-migrator.ts";
import { integer, text, sqliteTable } from "drizzle-orm/sqlite-core";
import { migrations } from "./migrations.generated.ts";

// 永続化を使う場合はcross-origin isolationを有効にしたWorker内で開く。
const client = await MoonDatabase.open("app");
const db = drizzle(client);
await migrate(db, migrations);

const notes = sqliteTable("notes", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
});
const note = db.insert(notes).values({ title: "hello" }).returning().get();
// { id: 1, title: "hello" }
```

`notes`のDDLはmigration側で作成する。Nodeでは`drizzle(new NodeDatabase(path))`と、Node専用の`adapters/drizzle-node.ts`の`migrate(db, { migrationsFolder })`を使える。このentryだけがDrizzle公式の`readMigrationFiles`を使ってファイルを読む。ブラウザ・DOにはビルド時に読み取った同じ`MigrationMeta[]`を渡す。[生成例](../../scripts/generate-drizzle-fixtures.ts)は公式Kitのsnapshot差分APIと公式readerを使用している。

DOではmigration用の排他処理も渡す。

```ts
const client = new DODatabase(ctx.storage, {
  exclusive: body => ctx.blockConcurrencyWhile(body),
});
await migrate(drizzle(client), migrations);
```

通常の同期クエリにはこのoptionは不要。外部キーを無効化する再構築migrationには必須で、未指定なら変更前に拒否する。

## 型とtransaction

| API | 対応と契約 |
| --- | --- |
| CRUD / RETURNING | INSERT・UPDATE・DELETE、全列 / 部分列 / 式、UPSERTのDO NOTHING / DO UPDATE、空の結果 |
| SELECT | 明示select、JOIN、left joinのnull化、where / inArray、prepared placeholder |
| 列位置 | `DrizzleClient.values()`が同名列を保持する。object結果から`Object.values()`で復元しない |
| 標準integer / boolean / Date | integer / Date列のdecoderへ安全なnumberを渡し、booleanは公式decoderで復元する。2^53を超えるnumber列のINTEGERは黙って丸めず、statementをrollbackして拒否 |
| 大きなINTEGER / BLOB | `sqliteInt64()`はbigint、`sqliteBytes()`はUint8Array。ブラウザ用にBuffer polyfillを追加しない |
| JSON / REAL / TEXT | 標準JSON text・REAL列、NUL / BOM、NULLを検証。下位のValue契約はINTEGER=bigint / REAL=numberを維持 |
| transaction | 同期callback、明示rollback、nested savepoint。RETURNINGのdecoder失敗もsavepointへ戻すため、外側でcatchしても失敗した行は残らない |
| `.run()` | `{ changes: number, lastInsertRowid: bigint }`。counterを型付きで取得 |

基盤のコントラクトは[DrizzleClient](../../src/drizzle-contract.ts)。MoonBitには動的SQLの位置付き結果を返す`database_exec_values`を追加した。既存のread-only `queryValues`と区別し、RETURNINGの書込と保存はtransaction内に置く。

DOのRETURNINGは列・star・bind・演算・CASE / CASTと、許可した決定的scalar関数（`upper` / `lower` / `coalesce` / `typeof` / `hex`等）を扱う。型と値の取得で式を繰り返すため、random・時計・接続counter・subquery・未知の関数は0行対象でも実行前に拒否する。匿名bindを`?N`へ一度だけ採番し、繰り返しで別の引数を消費しない。書込本体は一度だけ実行する。[許可一覧](../../adapters/do-returning.ts)が実装上の境界で、任意のSQLite式対応という宣言ではない。

## Migrationの検証範囲

[fixture](../../tests/fixtures/drizzle/migrations)を以下の順で適用する。生成SQLの不都合な部分をSQLike用に書き換えていない。

| 段階 | 種類 | 内容 |
| --- | --- | --- |
| 0 | Kit生成 | AUTOINCREMENT、NOT NULL、DEFAULT、外部キー付き2テーブル |
| 1 | Kit生成 | ADD COLUMN、複合index |
| 2 | Kit生成 | DROP COLUMN |
| 3 | Kit生成 | INTEGER→REAL、DEFAULT変更によるテーブル再構築 |
| 4 | Kit生成 | UNIQUE index・修飾付きCHECK追加、再構築 |
| 5 | Kit生成 | 列削除 |
| 6 | custom | テーブル名とカラム名の変更 |
| 7 | custom | view、降順index、部分式index、AFTER INSERT trigger |

Node / SQLike JS / Wasm GC / 本家SQLite WASMでは、各段階の行・子データ・FK mode / check・table_infoを本家Nodeと照合する。SQLikeは各段階で画像から再開する。ブラウザは実IndexedDBで各段階の再開、RETURNING付きCRUD、Service Workerを使ったオフライン再読み込みを検査する。DOも同じ8本を実workerdのSQLite storageへ適用し、再実行が0件になることを検査する。

- ファイルの元bytesのSHA-256、順序、適用済みの履歴全体とのprefix一致を検査。変更・欠落・順序違いは拒否する。
- 未適用のschema・データ・履歴を同じtransactionで確定する。制約違反・FK検証失敗はすべて戻す。
- `PRAGMA foreign_keys=OFF/ON`はtransaction外側のscopeへ移す。BEGIN後のOFFはSQLiteで無効なため、そのまま実行しない。最後にFK全体を検査し、元のmodeを復元する。
- DOは排他scopeで`storage.sync()`を待ち、implicit transactionを抜けてからOFFにする。親の再構築後にもCASCADEの子データを保持し、失敗時のDDL・履歴のrollbackとmode復元を検査する。
- breakpointがないcustom SQLも文ごとに適用する。引用・コメント・trigger本体・CASEを考慮して境界を取り、先頭文だけ実行して成功扱いにしない。migrationからのBEGIN / COMMIT等は実行前に拒否する。

実際のSQLで見つかったSQLikeの2点も修正した。修飾付きCHECKのカラムrenameで保存SQLと式木が食い違う問題と、`ON CONFLICT("table"."column")`を解析できない問題である。後者は動的 / AOTのJS・Wasmを本家と比較する。

## 残る制限

- Kit 0.31.11は、式や降順指定を含むindexを再構築すると式全体を列名としてquoteするSQLを生成する場合がある。[実際の生成SQL](../../tests/fixtures/drizzle/kit-0.31.11-invalid-index.sql)は本家SQLiteも拒否する。このケースは失敗する回帰テストとして残し、成功した8本へ合算しない。検証chainでは式 / 降順indexを最後のcustom migrationで追加した。
- `db.query.*`のrelational custom mapperは明示拒否する。検証対象は`select` / JOIN API。実装は固定版のDrizzle内部row mapperの公開runtime exportに依存するため、版を上げる際に再検証する。
- transaction callbackは同期専用。明示的な`behavior`（deferred / immediate / exclusive）の指定はportable driverでは拒否する。
- Tursoの非同期SDKはこの同期driverの対象外。AOTだけのDBにはSQL文字列を渡せないため、このdriverを直接使えない。Drizzle queryをビルド時にcatalog化して照合するadapterは未実装で、動的Drizzle entryにはSQL parserが必要。
- 全SQLite文法・全Drizzle機能・全migration組み合わせの保証ではない。検証対象外は[既存の対応範囲](status-and-improvement-plan.md)に従う。0.1.0の対応範囲に含める。

## 再現と容量

```sh
just drizzle-fixtures # 固定版Kitでfixtureを再生成
just drizzle-check    # native/JS/Wasm、ブラウザIDB、実DO
just measure-drizzle # ORMを選択した場合の追加容量
```

[容量の全量](../../measurements/drizzle-size-current.json)、[ブラウザ結果](../../measurements/drizzle-browser-current.json)、[DO結果](../../measurements/drizzle-do-current.json)。容量はSQLike adapterの全公開APIを残したビルドと、Drizzle＋migratorも残したビルドの差で測る。dynamic persistence chunk / Workerを含め、assetごとに圧縮して合算する。アプリの初回転送量やORMの速度測定とは区別する。[既定buildのguard](../../scripts/production-boundary.ts)でORMの意図しない混入を検出する。LSM / FTSも引き続き既定バンドルへ含めない。

Drizzle対応時点の[固定した計測](../../measurements/defined-before/drizzle-size-current.json)ではBrotli合計148,400 → 165,252 B、**追加16,852 B（16.46 KiB）**。minified rawは+79,622 B、gzipは+19,518 B。既定AOTアプリの当時の初回転送は116,195 B（113.47 KiB）で、Drizzleを含めていない。その後のバイナリ定義対応を含む現行値は[改善台帳](status-and-improvement-plan.md)を参照する。Programは20,049 Bのまま。単発の速度差をDrizzleによる改善とは判定しない。

参照: [Drizzle公式migration](https://orm.drizzle.team/docs/migrations)、[Kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate)、[DO storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。
