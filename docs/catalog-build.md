# 登録クエリからランタイムを絞る

0.1.0以後の未リリース機能。固定DDLとnamed queryのcatalogをビルド時に渡すと、必要な任意機能・coreの関数群・文の種類を推定し、使わない実装をJS / Wasmから除去できます。JSON AOTの`aot`と、バイナリ定義の`defined`に対応します。

```mermaid
flowchart LR
  A[固定DDLとnamed SQL] --> B[型付きIRを走査]
  B --> C[依存する機能と定数を生成]
  C --> D[Moonで不要な実装を除去]
  D --> E[parserなしのJS / Wasm]
```

## ビルドする

リポジトリのビルドツールを使います。Node 24+とMoonBitが必要です。`catalog`オプションへ、`buildDefinedCatalog()`や`buildCatalog()`と同じ`CatalogSource`を渡します。

```ts
import { readFile } from 'node:fs/promises';
import { defineSqlike, primaryKeyIndex } from './src/sqlike-features.ts';
import { buildSqlikeRuntime } from './scripts/build-sqlike-runtime.ts';
import { buildDefinedCatalog } from './scripts/defined-compiler.ts';

const source = JSON.parse(await readFile('examples/notes/catalog.json', 'utf8'));
const definition = buildDefinedCatalog(source);
const built = await buildSqlikeRuntime(
  defineSqlike({ mode: 'defined', features: [primaryKeyIndex] }),
  { catalog: source, outDir: 'generated/notes/runtime' },
);
console.log(built.requirements);
// functionGroups: ['aggregates']
// statements: ['delete', 'insert', 'select', 'update']
```

事前に`pnpm build:core`でcompilerをビルドします。`definition`は[固定DDLとprepared statement](prepared.md)と同じ定義データで、ランタイムとは別に配信します。ブラウザでは生成したruntimeを`createDefinedDatabase()`へ注入します。`aot`モードの場合は、同じsourceから作った`buildCatalog(source).artifact`を`openCompiled()`へ渡します。

```ts
import * as runtime from './generated/notes/runtime/runtime.js';
import { createDefinedDatabase } from '@mizchi/sqlike/defined/core';
import { catalog as definition } from './catalog.generated.js';

const DB = createDefinedDatabase(runtime);
const db = await DB.open('notes', definition); // definitionは配信した定義データ
await db.execute('add', [1n, 'hello', 0n]);
```

Wasmには`@mizchi/sqlike/defined/wasm`の`definedWasm(instance.exports)`を注入します。定義・保存形式は変更せず、既存のIndexedDB、snapshot、delta、オフライン再開の契約を使えます。

CLIではprofileファイルの`catalog`にsourceのパスを指定できます。パスの基準はprofileファイルのディレクトリです。sourceオブジェクトを直接埋め込むこともできます。

```json
{
  "mode": "defined",
  "features": ["primaryKeyIndex"],
  "catalog": "../notes/catalog.json"
}
```

```sh
pnpm build:core
just sqlike-runtime examples/profiles/notes-catalog-defined.json generated/notes/runtime
```

## 何を残すか

登録した全クエリに加え、固定schemaのDEFAULT・CHECK・view・index式・部分indexの条件・trigger本体を走査します。bind値によって通る分岐が変わっても動作するよう、未実行CASEや空テーブルの式も対象にします。文字列・コメント中にある関数名は対象になりません。FKのcascadeなど、選択した実装から内部的に必要な処理はリンク時の依存として残ります。

| 選択単位 | 扱い |
| --- | --- |
| JSON・日時・window・STRICT・FK・trigger・外部結合・索引metadata・FILTER | 必要な既存feature tokenを自動追加 |
| core関数群 | GLOB、LIKE、char、substring、trim、roundなどを個別に除去。lower/upper、min/maxなどは実装を共有する単位で選択 |
| 通常の集約・group_concat | 別の関数群として選択。window集約に必要な依存も収集 |
| SELECT / INSERT / UPDATE / DELETE / transaction / PRAGMA | 登録クエリとtrigger本体に必要な文の実装を選択 |
| 主キー索引 | 性能とメモリの選択なので、`primaryKeyIndex`で明示指定 |
| SQLite出力・LTX | `sqlitePages` / `ltx`を明示指定。`defined`は従来どおり別exporterを使用 |

`catalog`を省くと従来の手動プロファイルになります。指定した`features`は、自動推定した必須機能へ追加されます。たとえば不要な`sqlJson`を明示すると、その実装も残ります。

SQLの型変換・比較、汎用のquery実行器、JOIN・CTE・compoundの細分化は今回の対象外です。SQL JSON・日時・window内部の各関数も、既存の大きな機能単位で残ります。クエリごとの専用機械語へ変換する仕組みではありません。

## 生成結果を調べる

`profile.json`の`requirements`に次を記録します。

- `artifactSHA256` / `sourceSHA256`: 解析した定義とsourceの再現用hash
- `features`: 自動推定した意味上の必須機能
- `functions` / `functionGroups`: 検出した呼出し名と、実装を選ぶ単位
- `statements`: 必要な文の種類

解析だけなら、Node用の`@mizchi/sqlike/compiler`から実行できます。このentryの`analyzeCatalogRequirements()`も未リリースです。

```ts
import { analyzeCatalogRequirements } from '@mizchi/sqlike/compiler';
const requirements = analyzeCatalogRequirements(source);
```

解析器は[バイナリの型契約](../src/binary-wire.json)から生成する型付きvisitorです。[関数群の契約](../src/runtime-capabilities.json)とともに再生成・hashを検証し、SQLの文字列検索には依存しません。

除去した機能を使う別catalogは、ロード時に`catalog capability disabled`で拒否します。クエリを追加したら再ビルドしてください。同じ選択単位に収まるcatalogは使えます。profileのhashは再現用の情報で、認可の境界としては使いません。定義・保存画像のschema / program identityは従来の契約で検査します。

## 容量と検証

<!-- catalog-size:start -->
| Catalog / mode | JS minified 前→後 | JS Brotli 前→後 | Wasm Brotli 前→後 |
| --- | ---: | ---: | ---: |
| readonly / aot | 452.18→398.44 KiB | 85.76→75.15 KiB | 127.38→112.18 KiB |
| readonly / defined | 421.77→369.09 KiB | 82.94→72.64 KiB | 121.51→106.46 KiB |
| scalar-read / aot | 452.18→401.21 KiB | 85.76→75.92 KiB | 127.38→112.81 KiB |
| scalar-read / defined | 421.77→371.86 KiB | 82.94→73.23 KiB | 121.51→107.50 KiB |
| notes / aot | 452.18→425.19 KiB | 85.76→80.29 KiB | 127.38→119.57 KiB |
| notes / defined | 421.77→395.60 KiB | 82.94→77.80 KiB | 121.51→113.72 KiB |
<!-- catalog-size:end -->

比較はランタイム単体です。同じ意味上のfeature・主キー索引・公開exportsを使い、通常プロファイルとcatalog指定を比べます。Oxc minify後のJS、release Wasm、ファイルごとのBrotli quality 11を集計します。host・IndexedDB wrapper・定義データ・compilerを含まないため、READMEのアプリ配信量とは範囲が異なります。

```sh
just catalog-profiles
```

[計測JSON](../measurements/catalog-profiles-current.json)は全fixtureを通常 / 自動選択のJS・Wasmで本家と照合します。[単体差分](../tests/sqlike-catalog-profile.test.ts)は関数群の個別選択、未実行分岐、trigger、FK cascade、SQL transaction、余分な機能を持つcatalogの拒否を検査します。[Chromium](../e2e/catalog-profile.spec.ts)では、選択したruntimeだけを配信し、オフライン書込とIndexedDB再開を検証します。
