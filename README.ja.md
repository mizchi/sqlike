# SQLike

[English](README.md) | **日本語**

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

[GitHub Releases](https://github.com/mizchi/sqlike/releases/tag/v0.1.2)にも配布用アーカイブを用意しています。

## バンドルサイズ

ブラウザ向けの公開entryをOxcでminifyした配布物の合計です。JSローダー・分割chunk・生成されるWorker・Wasmを含み、Brotliは各ファイルをquality 11で圧縮して合算しています。1 KiB = 1,024 bytes。Wasmはrelease出力を使用します。

SQLikeは0.1.2以降の未リリース変更を含むソースで計測しています。[段階的な互換機能の導入](docs/internal/staged-sqlite-compatibility.md)に追加内容とサイズ差を記録します。

[![10構成のバンドルサイズ。青はBrotli、灰色はminify後の未圧縮サイズ。小さいほど軽量。](docs/images/bundle-size.png)](docs/images/bundle-size.png)

[SVG版](docs/images/bundle-size.svg)

横軸は対数目盛で、1目盛ごとにサイズが2倍になります。点に記載した数値はKiBです。

<details>
<summary>数値を表で見る（10構成）</summary>

<!-- bundle-size:start -->
| ビルド | minified・未圧縮 | Brotli |
| --- | ---: | ---: |
| SQLike 0.1.2 (source) / 通常SQL / JS | 630.25 KiB | 118.17 KiB |
| SQLike 0.1.2 (source) / 通常SQL / Wasm GC | 555.06 KiB | 174.23 KiB |
| SQLike 0.1.2 (source) / 事前定義・全実行機能 / JS | 516.56 KiB | 102.25 KiB |
| SQLike 0.1.2 (source) / 事前定義・全実行機能 / Wasm GC | 458.04 KiB | 146.80 KiB |
| SQLike 0.1.2 (source) / 事前定義・JSON・日時・windowなし / JS | 476.71 KiB | 94.07 KiB |
| SQLike 0.1.2 (source) / 事前定義・JSON・日時・windowなし / Wasm GC | 427.70 KiB | 136.42 KiB |
| SQLike 0.1.2 (source) / 事前定義・主キー索引のみ / JS | 455.28 KiB | 90.03 KiB |
| SQLike 0.1.2 (source) / 事前定義・主キー索引のみ / Wasm GC | 409.60 KiB | 131.02 KiB |
| sqlite-wasm 3.54.1-build1 | 1313.74 KiB | 462.33 KiB |
| Turso 0.8.3 | 11709.66 KiB | 2675.96 KiB |
<!-- bundle-size:end -->

</details>

事前定義版はSQLパーサを含みません。機能選択版とWasm GC版は、同じ公開host APIを使うカスタムビルドです。「主キー索引のみ」は任意機能の選択で、CRUD・集約・CTE・secondary indexはコアに残ります。SQLikeはSQLiteサブセットのため、他のエンジンと機能範囲は異なります。

表は手動の機能プロファイルです。[catalog別のビルド](docs/catalog-build.md)では、未使用の関数群・文・JOIN・CTE・複合SELECTの実装も除去できます。そのランタイムのサイズを下に示します。

アプリのHTML・コード、事前ビルドしたschema / statement、ビルド時compiler、任意のSQLite exporter、Litestreamは含みません。任意Workerも含む配布assetの合計であり、初回起動時の最小ダウンロード量とは異なります。各行の計測済みminified bundleはChromiumでDBを開いて書込・読取まで確認しています。

比較対象は[@sqlite.org/sqlite-wasm](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm)と[@tursodatabase/database-wasm](https://www.npmjs.com/package/@tursodatabase/database-wasm)です。

[計測条件・ファイル別サイズ](measurements/bundle-size-current.json)。再計測は`just bundle-size`で行えます。

### catalogから絞ったランタイム

schemaとクエリが固定されている場合、AOTと事前定義版ではcatalogに必要な実装だけを残せます。AOTはJSONのプログラム定義、`defined`はバイナリ定義を読み込みます。各比較で、意味上の機能・公開exports・主キー索引の設定を揃えています。

[![6つのcatalogのdefined JSランタイム。灰色は手動プロファイル、青はcatalogから選択した構成。minifiedとBrotliの2図で比較。](docs/images/catalog-runtime-size.png)](docs/images/catalog-runtime-size.png)

[SVG版](docs/images/catalog-runtime-size.svg)

下表は**エンジンのファイル単体**で、host・IndexedDB wrapper・schema / statement・compilerを含みません。JSとWasmは別々の実行対象で、Wasmの値にはJSローダーを含みません。上の配信全体の表ではhostとローダーも含めています。すべてのcatalogをJS / Wasmの両方でnative SQLiteと照合済みです。

<details>
<summary>ランタイムの数値を見る（6 catalog × 2モード）</summary>

<!-- catalog-runtime-size:start -->
| Catalog / モード | minified JS | JS Brotli | release Wasm | Wasm Brotli |
| --- | ---: | ---: | ---: | ---: |
| 読取専用 / AOT | 402.87 KiB | 75.34 KiB | 360.55 KiB | 112.25 KiB |
| 読取専用 / defined | 373.49 KiB | 72.70 KiB | 332.85 KiB | 106.39 KiB |
| GLOB + char / AOT | 405.64 KiB | 75.88 KiB | 364.94 KiB | 113.54 KiB |
| GLOB + char / defined | 376.26 KiB | 73.43 KiB | 335.33 KiB | 107.46 KiB |
| JSON生成 / AOT | 409.15 KiB | 76.35 KiB | 366.41 KiB | 114.15 KiB |
| JSON生成 / defined | 379.72 KiB | 73.71 KiB | 337.67 KiB | 107.78 KiB |
| 入れ子JSON / AOT | 413.89 KiB | 77.04 KiB | 370.75 KiB | 114.82 KiB |
| 入れ子JSON / defined | 384.38 KiB | 74.47 KiB | 341.92 KiB | 109.05 KiB |
| 再帰CTE＋JSON集約 / AOT | 422.33 KiB | 78.68 KiB | 380.62 KiB | 117.75 KiB |
| 再帰CTE＋JSON集約 / defined | 392.82 KiB | 76.08 KiB | 352.01 KiB | 111.69 KiB |
| Notes CRUD / AOT | 434.29 KiB | 81.18 KiB | 388.69 KiB | 120.77 KiB |
| Notes CRUD / defined | 404.63 KiB | 78.57 KiB | 358.96 KiB | 114.97 KiB |
<!-- catalog-runtime-size:end -->

</details>

catalogは主キー検索、GLOB / char、JSON生成、入れ子JSON、再帰CTE＋JSON集約、メモのCRUDを対象にしています。残る機能はcatalogによって異なります。単純なJSON生成だけなら、SQL JSONパーサ・パス解析・編集・patch・集約も除去します。

[catalogの計測結果](measurements/catalog-profiles-current.json) · [ビルド方法・制限](docs/catalog-build.md)。再計測は`just catalog-profiles`、図表の更新は`just readme-charts`で行えます。

## SQLiteとの速度比較

5,000行のテーブルでの**μs/操作**（小さいほど高速）、ウォームアップ後7サンプルの中央値です。通常SQLは毎回SQLをパース・prepareし、prepared列はSQLiteのstatementを再利用します。

[![SQLiteとの速度比較。7処理を個別の横棒グラフで比較。各処理内で短い棒ほど高速。](docs/images/sqlite-benchmark.png)](docs/images/sqlite-benchmark.png)

[SVG版](docs/images/sqlite-benchmark.svg)

各グラフの軸はゼロ始まりですが、処理ごとに目盛幅が異なります。棒は中央値、ひげは7サンプルの最小〜最大です。全件取得のみ単位をmsにしています。画像をクリックすると原寸のPNGを開けます。

<details>
<summary>数値を表で見る（7処理・4経路、単位はすべてμs）</summary>

<!-- sqlite-benchmark:start -->
| 処理 | SQLike JS・通常SQL | SQLike Wasm GC・通常SQL | SQLite WASM・通常SQL | SQLite WASM・prepared |
| --- | ---: | ---: | ---: | ---: |
| 主キーで1行検索 | 26.33 | 6.37 | 3.83 | 1.49 |
| 存在しない主キーの検索 | 26.33 | 5.43 | 2.56 | 0.48 |
| 二次索引の範囲検索・10行 | 42.87 | 11.81 | 14.79 | 10.74 |
| ORDER BY id LIMIT 10 | 41.64 | 9.02 | 12.61 | 9.59 |
| sum(n), count(*) | 94.58 | 52.71 | 113.89 | 111.75 |
| 全5,000行取得 | 1,924.14 | 2,037.04 | 4,990.91 | 4,933.33 |
| 索引列の更新＋範囲10行取得 | 71.60 | 16.95 | 19.46 | 13.26 |
<!-- sqlite-benchmark:end -->

</details>

2026-11-17、Apple M5 / macOS arm64 / Chromium 158.0.8127.18で計測。SQLike 0.1.2以降の未リリースソースのMoonBit release出力（JSはminify前）と、SQLite WASM 3.54.1を同じページ内のインメモリDBで実行しています。

主キー・二次索引はウォーム状態です。更新の行は索引列の値を交互に変更し、その後の範囲検索までを含みます。結果の型変換と復号を含むエンジンAPIの比較で、host wrapper、起動・Wasmコンパイル、IndexedDB、通信は含みません。計測前後にnative SQLite由来の期待値と更新結果を照合しています。

通常SQLではパースとホスト境界のコストがあり、特に小さな検索でSQLiteとの差が残っています。実アプリの速度はクエリ・返却行数・永続化方式でも変わります。

[生データ・クエリ・全サンプル](measurements/sqlite-speed-current.json)。再計測は`just sqlite-bench --profiles=false`で行えます。

[10万行での比較](docs/internal/sqlite-large-benchmark.md)も掲載しています。SQLikeの任意statement cacheを含む8経路を、短いサンプル予算で計測します。

<details>
<summary>10万行・8経路のグラフを見る</summary>

[![10万行・10処理・8経路のSQLite比較。短い棒ほど高速。ひげは3サンプルの最小〜最大。](docs/images/sqlite-large-benchmark.png)](docs/images/sqlite-large-benchmark.png)

[SVG版](docs/images/sqlite-large-benchmark.svg)

各パネルの軸はゼロ始まりで、尺度は処理ごとに異なります。集約と全件取得はms、ほかはµs。ひげは観測した最小〜最大で、信頼区間ではありません。

</details>

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

未リリースのソースでは、同じSQLを反復する接続に`openDatabase(undefined, { statementCache: { capacity: 32 } })`でcacheを有効にできます。接続ごとに保持する文とSQL本文の量を制限し、schema変更後は再準備します。[利用範囲と計測](docs/internal/dynamic-sql-prepare.md)。

## IndexedDBへ保存する

ブラウザで使うschemaと問い合わせが決まっている場合は、ビルド時にDDLとnamed statementをコンパイルできます。実行側はバイナリ定義を読み込み、SQLパーサを配信せずに動きます。

0.1.2では、固定schemaのUPDATEと単純な主キーSELECTで準備済み実行計画を再利用します。bind値はクエリ構造と分離し、既存catalog・保存データの形式を維持します。

0.1.1では、[catalogから必要な機能を自動推定](docs/catalog-build.md)し、未使用の関数群・文・JOIN・CTE・複合SELECTの実装を除去できます。JSONの解析・生成・編集・patch・集約も別々に選択します。

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

0.1.1では、[Drizzleクエリを事前定義catalogへ変換](docs/drizzle-prepared.md)し、ブラウザへORMとSQL parserを配信しない構成も使えます。

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
moon add mizchi/sqlike@0.1.2
moon add mizchi/litestream@0.1.2
```

[SQLikeのAPI](packages/sqlike/README.md) / [LitestreamのAPI](packages/litestream/README.md)

MIT License。[リリース](https://github.com/mizchi/sqlike/releases) / [ユーザー向けガイド](docs/README.md) / [開発者向けドキュメント](docs/internal/README.md)
