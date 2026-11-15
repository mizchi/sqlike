# 固定DDLとprepared statementのバイナリ初期化

2026-11-16、開発版0.0.1。DDLとnamed statementをビルド時にコンパイルし、実行側はバイナリ定義だけで初期化する。`mizchi/sqlike/defined`はDDLパーサ・ALTER処理・Program / schema / ASTのJSON復元を含まない独立entry。既存の動的SQL、Drizzle、JSON AOTは従来entryで維持する。

## ビルドと利用

入力は既存の[catalog形式](../examples/notes/catalog.json)を使う。

```json
{
  "schema": ["CREATE TABLE notes(id INTEGER PRIMARY KEY,title TEXT NOT NULL)"],
  "queries": [
    {"name":"add","sql":"INSERT INTO notes VALUES(?,?) RETURNING id,title"},
    {"name":"get","sql":"SELECT id,title FROM notes WHERE id=?"}
  ]
}
```

```sh
just compile-defined catalog.json generated/notes
# SQLite画像を必要とする場合だけテンプレートも生成する。
just compile-defined catalog.json generated/notes --sqlite-export
```

生成物:

| ファイル | 内容 |
| --- | --- |
| `.schema.bin` | テーブル・列・制約・index・view・triggerの固定定義 |
| `.statements.bin` | schemaId、登録名、bind数、結果列、解析済みstatement IR |
| `.manifest.json` | 形式・schemaId / programId・各ファイルのSHA-256・query metadata |
| `.ts` | schema / statementsのUint8Array、manifest、catalog。実行コードやcompiler importを含まない |
| `.sqlite.bin` | `--sqlite-export`時だけ生成する物理layoutと空SQLiteテンプレート。`.ts`には含めない |

```ts
import { DefinedDatabase } from "../adapters/defined-database.ts";
import { catalog } from "./generated/notes.ts";

// メモリだけなら await DefinedDatabase.memory(catalog)
const db = await DefinedDatabase.open("notes", catalog);
await db.prepare("add").execute([9007199254740993n, "hello"]);
const row = await db.prepare("get").get([9007199254740993n]);
// [9007199254740993n, "hello"]
await db.close();
```

`prepare()`はcatalogの名前を受け取る。実行時にSQL文字列やDDLを解析するAPIではなく、未登録名は変更前に拒否する。bindと結果は既存のValue契約に従い、INTEGERはbigint、REALはnumber、BLOBはUint8Array。`all()`は列位置を保つ二次元配列、`get()`は先頭行またはundefinedを返す。書込結果の列もRETURNINGで取得できる。

`open()`は既存のImageStore factoryを差し替え可能。既定はIndexedDBの非同期保存で、Atomics / SharedArrayBufferは不要。DB名は英数字・`_`・`-`の1〜56文字。`defined-`名前空間を使い、既存のJSON AOT保存領域を上書きしない。

## 必要機能だけを含むビルド

日時・SQL JSON・windowを使わないnotes向け構成は、次のコマンドで生成する。主キー索引だけを有効にし、DDL parserに加えてこの3機能とその他の任意機能を除く。

```sh
just sqlike-runtime examples/profiles/notes-defined.json generated/notes-defined
```

```ts
import * as runtime from "../generated/notes-defined/runtime.js";
import { createDefinedDatabase } from "../adapters/defined-database-core.ts";
import { catalog } from "./generated/notes.ts";

const DefinedDatabase = createDefinedDatabase(runtime);
const db = await DefinedDatabase.open("notes", catalog);
await db.prepare("add").execute([1n, "hello"]);
await db.close();
```

生成JSは既定でOxc minify済みで、`profile.json`に圧縮設定を記録する。このcore adapterは既定のエンジンをimportしない。`adapters/defined-database.ts`は全機能版を組み合わせる便利な入口なので、選択ビルドでは上記のcore adapterを使う。生成した`runtime.d.ts`も同じ契約を持つ。Wasm GCの場合はexportsを`definedWasm()`で包んでからfactoryへ渡す。

プロファイルの`features`へ`sqlJson`・`dateTime`・`windowFunctions`を追加すると、それぞれ独立して有効になる。[全トークンとモードの制約](sqlike-feature-profiles.md)を参照。定義が必要とする機能の不足は読み込み時に拒否する。日時文字列をTEXTとして保存するだけなら`dateTime`は不要だが、`DEFAULT CURRENT_TIMESTAMP`は日時機能を要求する。通常の集約・数値変換・bind / 結果のJSON ABIは除かない。

`just optional-functions-check`で、選択ビルドのJS / Wasm、本家との差分、IndexedDBの競合・abort・オフライン再開を検査する。サイズは`just measure-optional-functions`で別に測定する。

MoonBitからは既存の型付きインターフェースへ接続できる。

```moonbit
let program = @sqlike.Program::load_binary(schema_bytes, statement_bytes)
let connection = @sqlike.Connection::from_program(program)
let statement = connection.prepare_compiled(program.query("get"))
statement.bind(index=1, 9007199254740993L)
if statement.step() {
  let id : Int64 = statement.column(index=0)
  ignore(id)
}
statement.finalize()
connection.close()
```

## スキーマと可変データの分離

初期化時はバイナリから固定定義を構築し、登録queryの名前・bind数・結果metadata・制約・機能を検査する。DDLのCREATE文を実行し直さない。schemaIdはスキーマframeのSHA-256で、statement frameは対象schemaIdを持つ。別スキーマのstatementは読み込み時に拒否する。

queryの追加や変更だけならschemaIdを維持するため、同じ行データを新しいcatalogで開ける。宣言の既定値表記もビルド時に回収し、metadata queryの追加でschemaIdが変わらないようにした。schemaIdはバイナリ定義の同一性であり、異なるDDLの意味的な同値判定ではない。DDLや定義の並び・原文を変えた場合には別IDとなり得る。

snapshotはschemaId、serial、changes / last_rowid、テーブル順のsequenceと行だけを保存する。DDL・schema・query ASTは再保存せず、再開時にはアプリから渡された固定定義へ結び付ける。通常のjournalは変更行 / 変更列のバイナリpatchで、元の大きな未変更列を含めない。再適用はmaterializedな行変更であり、triggerやFK cascadeを再実行しない。

deltaは同一ImageStoreの世代CASにつながるローカル保存ログ。独立writer間のmergeや、ネットワーク同期相手の変更を認可するフォーマットではない。

公開は既存のstrict ImageStore / 世代CASで行う。候補cloneの実行・結果変換が成功した後に保存し、durable commit後にだけACKして公開する。BEGIN / COMMIT / ROLLBACK等もcatalogへ登録でき、明示transactionの途中は保存しない。abort・古いwriter・ACK消失の後は再開を要求し、保存済みの結果を読み直す。

## Wire v1

独自の定義・保存形式で、SQLiteファイルやLTXそのものとは別の形式。

```text
offset  size
0       4      "SQLK"
4       1      version = 1
5       1      kind
6       2      reserved = 0
8       4      requiredFeatures, little endian
12      4      payload length, little endian
16      ...    string pool + typed payload
end-32  32     SHA-256(header + payload)
```

kindはschema=1、statements=2、SQLite layout=3、snapshot=4、delta=5。string poolはUTF-8、参照・長さ・variant tagはcanonical unsigned LEB128、Int32はZigZag、int64 / IEEE754 float64はlittle endian。NULL / INTEGER / REAL / TEXT / BLOBを明示tagで区別し、整数をNumberへ丸めない。REALの負のゼロ・無限大を保持し、NaNは拒否する。BOM / NULも文字列の一部として保持する。

必須機能bitはFK=1、trigger=2、STRICT=4、拡張JOIN=8、SQL JSON=16、日時=32、window=64。実際に読んだ定義から再計算してheaderと照合する。未知の必須bit・version / kind / tag、非canonical整数、壊れたUTF-8・参照・長さ、末尾の余剰bytesは拒否する。readerのネスト上限256、array / string pool上限100,000、schema / statement / layout各1 MiB、snapshot / delta各64 MiB。保存先の上限はwrapper・Base64を含む保存サイズにも適用される。

[wireの型・tag・field順](../src/binary-wire.json)をコントラクトとして、[generator](../scripts/generate-binary-codecs.ts)からcodecを再生成する。契約のhashを生成物へ記録し、未再生成をテストで検出する。tagやfieldの変更にはwire versionの検討が必要で、MoonBitの型定義の並びをそのままwire ABIとして使わない。

```sh
just defined-codecs
just defined-check
just measure-defined
```

## SQLite出力と既存経路

SQLite画像が必要な利用側だけ、[optional exporter](../adapters/defined-sqlite.ts)をimportする。

```ts
import { exportDefinedSQLite } from "../adapters/defined-sqlite.ts";
const storage = new Uint8Array(await (await fetch("./notes.sqlite.bin")).arrayBuffer());
const sqlite = await exportDefinedSQLite({ ...catalog, storage }, await db.snapshot());
```

SQLite用manifest hashは`--sqlite-export`時に生成される。layout / templateはschemaIdとファイルSHA-256を照合する。SQLite / LTXのcodecや生成物を実行用entryへ強制的に含めない。ただし、現状のexporterは独立コンパイルのため、評価器などの共有処理を重複して含む。必要な場合の総配信量はコアとの合計で判断する。処理の共通化やmaterializedなindex入力への分離は今後の改善対象。

元DDLは`sqlite_schema.sql`等の互換metadataとして定義に残す。DDL parser / schema編集処理を含めるものではない。既存のJSON画像は従来AotDatabase / MoonDatabaseで読み続けられる。新entryによるJSON画像の自動変換、異なるschemaId間のmigration、Drizzleの動的driver、既存AOTのLTX outbox / upload APIの直接接続は今回の対象外。変更後のスキーマで既存保存を黙って上書きしない。

## 検証とサイズ

単体サイズはOxcで空白と識別子を圧縮し、公開APIとpurity annotationを保持する。[JS圧縮の比較](minification.md)と、空白を保持していた[採用前の基準](../measurements/oxc-before)を参照。

[Node tests](../tests/defined-database.test.ts)、[保存障害](../tests/defined-persistence.test.ts)、[JS / Wasm・wire・SQLite出力](../tests/defined-wire.test.ts)、[Chromium IndexedDB / offline](../e2e/defined.spec.ts)を用意した。型・RETURNING・CHECK / UNIQUE・FK cascade・trigger、明示transaction、変更列patch、stale writer、abort / ACK消失、破損データを検査する。STRICT・式index・view・JSON・日時・CTE・window・FULL JOINも本家と比較する。

上流select1の全1,000クエリは、JSON AOTのJS / WasmとバイナリAOTのJS / Wasmに、3機能を除いた選択ビルドのJS / Wasmを加えた6経路で本家SQLiteと一致した。SHA-256とバイナリの同一性もJS / Wasm / Nodeで照合する。Wasm GCのBytesはJS境界でopaqueなので、任意の[transfer adapter](../adapters/defined-wasm.ts)が明示的なBase64 ABIを使う。JS既定経路はUint8Arrayをそのまま使う。

notesの定義はschema **314 B**＋statements **495 B**。任意のSQLite layout / templateは**12,484 B**で別ファイル。[サイズ・初期化計測](../measurements/defined-size-current.json)と[ブラウザ結果](../measurements/defined-browser-current.json)はsource / artifact hash付きで保存する。サイズは選択した機能・公開entry・圧縮方法に依存し、エンジン単体・host込み・アプリ初回転送を区別する。初期化測定は非圧縮のMoon出力を利用し、IDB / host Crypto / query実行を含まない。Oxcの圧縮前後を比べた速度測定ではない。

| JS entry | minified raw | gzip | Brotli |
| --- | ---: | ---: | ---: |
| バイナリ実行コア | 461.05 KiB | 113.66 KiB | **91.09 KiB** |
| named API / 保存host込み | 472.90 KiB | 118.35 KiB | **95.03 KiB** |
| 任意のSQLite exporter | 416.38 KiB | 103.71 KiB | **83.08 KiB** |

同じ公開APIを持つ選択ビルドの[実測](../measurements/optional-functions-current.json):

| 構成 | core minified raw | core Brotli | host / 保存込みBrotli |
| --- | ---: | ---: | ---: |
| 全実行機能 | 461.05 KiB | 91.09 KiB | 94.91 KiB |
| 日時のみ除去 | 457.37 KiB | 89.35 KiB | 93.45 KiB |
| SQL JSONのみ除去 | 455.28 KiB | 89.19 KiB | 93.09 KiB |
| windowのみ除去 | 457.40 KiB | 89.23 KiB | 93.36 KiB |
| 3機能を除去 | 428.23 KiB | 84.15 KiB | 88.17 KiB |
| 主キー索引だけ | 412.76 KiB | 81.09 KiB | 85.14 KiB |

3機能の一括除去はraw **32.82 KiB**、Brotli **6.94 KiB**の削減。Oxcで空白を保持していた前回の8.57 KiBとは圧縮条件が異なる。共有処理の到達性も変わるため、個別の削減量を足し合わせない。無効機能の検出・拒否処理を含む動作可能なビルドであり、以前のthrow置換による試算とは別。SQLite exporter・LTX・ネットワーク・定義データは表へ含めない。既定entryと選択entryはビルド条件が異なるため、上の表と小差がある。Wasm GCの容量も同じJSONへ保存したが、今回は速度向上の比較実験を行っていない。

コアにはDDL / schema編集・schema / AST / ProgramのJSON reader・SQLite writerがないことを成果物で検査する。JSONのbind / 結果ABI、ホストの小さな保存metadataは残る。独立したexporterは共有評価器等が重複するため、コアと両方使う総量の改善とは扱わない。

Node 24.22.2、同じnotes DDL / queryでSQLite layoutを両loaderから除いた初期化は、9試行の中央値でJSON AOT **77.91 µs**、binary **33.33 µs**。型・定義・query metadataの読み込みと検証を含む同期coreの比較であり、IDB・アプリ起動・hostのSHA-256・query速度の比較ではない。変更前の他の性能記録との単発差も、今回の改善量へ合算しない。

バイナリ化で実行時の全関数・AST評価器がアプリ専用になるわけではない。JSON / 日時 / windowの独立した機能選択は実装済み。codec以外の汎用評価器の削減、migration plan / 旧形式readerの外付けは改善対象として残す。SQLite全機能互換の宣言ではなく、0.1.0に含める。
