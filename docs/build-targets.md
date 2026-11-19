# baseline・full・AOTと出力先

0.1.2以降の未リリース変更です。公開済み0.1.2の既定entryは従来の機能範囲です。

| 用途 | MoonBit | npm |
| --- | --- | --- |
| 基本機能の動的SQL | `mizchi/sqlike` | `@mizchi/sqlike` |
| 実装済みのSQL機能をすべて使う | `mizchi/sqlike/full` | `@mizchi/sqlike/full` |
| 事前定義したnamed statement | `mizchi/sqlike/aot` | `@mizchi/sqlike/aot` |
| JS専用の高速な値受け渡し | — | `@mizchi/sqlike/aot/native` |

baselineにはCRUD、RETURNING、INNER / LEFT JOIN、集約、transaction、index定義と制約、主キー索引、FK、STRICTと通常のscalar関数を含めます。JSON、日時、window、trigger、CTE、複合SELECT、RIGHT / FULL JOIN、追加の任意機能はfullを使います。baselineの二次索引は制約に使えますが、並び順と範囲検索を高速化する大きなoptimizerは含めません。

fullはSQLikeに実装済みの範囲です。SQLite全機能互換を意味しません。省いた機能を使う問い合わせは拒否します。既存アプリでrootからJSONやCTE等を使っている場合は、fullへimportを変更します。MoonBitの各entryの型はそれぞれ独立しているため、Connection / Program / Statementをentry間で渡さないでください。

## 出力を分岐する理由

同じ依存グラフとcatalog解析から、出力だけを分けます。

```mermaid
flowchart TD
  catalog[DDLとnamed SQL] --> ir[型付きIRと必要機能]
  graph[依存グラフ] --> plan[閉包とoptimizer選択]
  ir --> plan
  plan --> source[MoonBitソースを生成]
  source --> consumer[利用側のMoonBitリンク]
  consumer --> moonjs[JS]
  consumer --> moonwasm[Wasm GC]
  plan --> flat[単一engineへ定数を適用]
  flat --> link[MoonBitで一度だけリンク]
  link --> js[単独ESMへOXC minify]
  link --> wasm[単独Wasm GC]
```

JS向けは、別々にコンパイルしたMoonBitパッケージのJSを連結しません。選択した機能をcanonical engineへ適用して一度だけリンクします。MoonBit向けはライブラリのソースを出力し、標準ライブラリの共有と不要コード除去を利用側のMoonBitリンカへ任せます。generatedソースにはprivate実装も存在し、最終成果物からの除去は定数とリンカに依存します。

**既成のbaseline・full・AOT JSは独立したランタイムです。** 同じアプリから複数をimportすると、それぞれのMoonBit runtimeやengineが入ります。アプリには必要なentryを一つ選ぶか、custom runtimeを一つ生成してengineを含まないhostへ注入してください。MoonBitでも複数のengine entryを同時に使えばengine自体は別実装として残ります。

## JS / Wasm GCを直接出力する

Node 24+、MoonBit、リポジトリの依存を使います。

```sh
pnpm install --frozen-lockfile
pnpm build:core
just sqlike-runtime examples/profiles/notes-catalog-aot.json generated/notes-runtime
```

出力は`runtime.js`、`runtime.wasm`、`runtime.d.ts`、`profile.json`、`build-plan.json`です。JSとWasmは同じ選択結果でビルドします。CLIの`emitter`は既定で`flat-single-link`です。`targets`で片方だけを指定することもできます。

```js
import * as runtime from './generated/notes-runtime/runtime.js';
import { openPortableCompiled } from '@mizchi/sqlike/aot/core';
import program from './program.generated.js'; // buildCatalog(source).artifactを保存したデータ
const db = openPortableCompiled(runtime, program);
db.execute('add', [1n, 'hello', 1n]);
db.close();
```

Wasmの場合は`runtime.wasm`を配信し、同じProgramとhostを使います。

```js
import { aotWasm, openPortableCompiled } from '@mizchi/sqlike/aot/core';
const bytes = await (await fetch('./generated/notes-runtime/runtime.wasm')).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, {}, {
  builtins: ['js-string'], importedStringConstants: '_',
});
const db = openPortableCompiled(aotWasm(instance.exports), program);
```

JS / Wasm共通ABIはbindと結果にCell JSONを使い、prepared handleを再利用します。JSの値を直接受け渡す版は`nativeResults: true`で生成し、`openNativeCompiled`へ注入します。これはJS専用です。[値・寿命・rollbackの契約](native-aot.md)も参照してください。

## MoonBitのライブラリを出力する

```sh
just sqlike-runtime examples/profiles/notes-moonbit.json generated/notes-moonbit
# または
just emit-moonbit examples/notes/catalog.json generated/notes-moonbit app/notes-runtime
```

`moon.mod`、`src/aot/engine.mbt`、`src/aot/moon.pkg`、`program.json`、`build-plan.json`を生成します。`moon.work`へこのモジュールを追加し、利用側から`"app/notes-runtime/aot"`をimportします。`program.json`はビルド時に文字列へ埋め込むなどして渡します。

```moonbit
let db = @aot.Connection::open(program_text)
let q = db.prepare("get") // SQLではなく登録名
q.bind(index=1, 1L)
if q.step() {
  let title : String = q.column(index=1)
  ignore(title)
}
q.finalize()
db.close()
```

生成前にJSとWasm GC両方で`moon check`します。AOTソース出力で`sqlitePages`を指定するとSQLite出力関数と増分pagerの公開関数も使えます。LTXは独立した`mizchi/litestream`へSQLite画像または変更ページを渡します。[pagerと非同期provider](incremental-pager.md)を参照してください。ソース出力での`ltx`指定は拒否します。

## optimizerを選ぶ

profile JSONの`optimizers`を省くとcatalogに合わせて選びます。主キーのみのschemaでは二次索引range optimizerを外します。`"optimizers": []`ですべて無効にでき、例えば`["pointProjection","simpleScan"]`で個別指定できます。

| 設定名 | 高速化する処理 |
| --- | --- |
| `pointProjection` | 主キーで1行を取得し、式を計算するSELECT |
| `simpleScan` | 単純な走査、LIMIT、並べ替え |
| `secondaryRange` | 二次索引の範囲と順序を使うSELECT |
| `aggregateScan` | 単純な集約 |
| `jsonTableAggregate` | JSON tableの集約を順次処理 |
| `updateFromLookup` | UPDATE FROMの主キー検索 |
| `rowMetadata` | 行値式のaffinity / collationをprepare時に再利用（`rowValues`が必要） |
| `inListLookup` | 16要素以上のliteral / bind INリストを実行ごとに索引化 |

optimizerはSQLの意味上の機能とは別です。必要な意味上の機能を外した組合せや不明な設定名はビルド前に拒否します。無効化した場合、汎用経路を使います。結果が同じでも遅くなり、大きな入力では既存の実行量上限に達する場合があります。

## AOTの公開APIを選ぶ

portable AOTでは`apiCapabilities`で公開するAPIを選べます。省略時は従来の15 exportを維持し、`[]`では実行用の4 exportだけを残します。SQLの対応機能と公開APIは別に選びます。

| capability | 追加するAPI |
| --- | --- |
| `execute`（常に有効） | `aot_open` / `aot_info` / `aot_set_clock` / `aot_execute` |
| `prepared` | query情報、SELECT handleのprepare / execute / finalize。MoonBitの型付きConnection / Statement API |
| `snapshot` | dump / restore、open時の保存画像の読込 |
| `snapshotChunks`（任意） | `snapshot`に加えbinary行chunkのsnapshot / restoreとbytes accessor |
| `snapshotIncremental`（任意） | `snapshotChunks`に加え、独立frameの生成と未変更blockの再利用 |
| `transaction` | host transaction用のcloneとconnection counterのcopy |
| `delta` | 差分取得・ACK・適用 |

`snapshotChunks`と`snapshotIncremental`は既定のAPI集合に含めません。raw codecが必要な生成runtimeで明示指定します。`snapshot`だけのビルドにはbinary chunk codecをリンクしません。[行chunkの契約](internal/logical-snapshot-chunks.md)。

```sh
just sqlike-runtime examples/profiles/crud-executor.json generated/crud-executor
```

生成したruntimeと、同じcatalogを`buildCatalog()`でコンパイルしたProgramを使います。

```js
import * as runtime from './generated/crud-executor/runtime.js';
import { openAotExecutor } from '@mizchi/sqlike/aot/core';
const db = openAotExecutor(runtime, program);
db.execute('create', [1n, 'hello', 1n]);
console.log(db.execute('read', [1n]).rows); // [[1n, 'hello', 1n]]
db.close();
```

Wasm GCでは`aotExecutorWasm(instance.exports)`を渡します。必要なABIは接続を作る前に検査します。`openAotExecutor`は`execute` / `close`だけを公開し、named statementごとのprepared metadataと文単位のatomic rollbackを維持します。結果はeagerな配列で、streaming APIではありません。snapshot / host transaction / SELECT handleのmethodは持ちません。

従来の`openPortableCompiled`を使いながらdeltaだけを除く場合は、`apiCapabilities: ['prepared', 'snapshot', 'transaction']`を指定します。各APIを単独で選んだ場合はraw関数を使えます。MoonBitソース出力も同じ選択に従い、型付き`Connection::prepare`を使う場合は`prepared`を含めます。`snapshot`なしのruntimeへopen時の画像を渡すと拒否し、生成JSの型も空文字だけを許可します。

この選択はportable AOTが対象です。SQL / defined / `nativeResults: true`へ`apiCapabilities`を指定すると拒否します。JS native AOTは既存の14 exportを維持します。`transaction`はhost側の機能であり、catalogに登録したBEGIN / COMMIT等のSQL対応範囲を変える指定ではありません。

## 検証範囲

`just build-graph-check`は依存グラフの検査、Z3検証、外部MoonBit consumer、JS / WasmのAOT、optimizerなしのSQLite差分テストを実行します。Z3が必要です。

Z3で保証するのは**宣言した有限な依存グラフ**の閉包・最小性・単調性・冪等性です。すべてのSQLの正しさやコンパイラの正しさを証明するものではありません。出力ごとにコンパイルと公開export検査を行い、成功した出力だけを公開します。生成失敗時はstagingを破棄し、以前の出力を保持します。プロセス強制終了や電源断に対する永続的なatomic交換は保証しません。

[依存グラフと検証条件](internal/sqlike-build-contract.md) / [完全な生成グラフ](internal/sqlike-build-graph.mmd) / [計測値](../measurements/sqlike-entrypoints-current.json)
