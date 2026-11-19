# 事前コンパイル実行と LTX 生成

MoonBit の作業 DB を SQLite 互換ページに書き出し、LTX v3 を生成する。SQL とスキーマはアプリのビルド時に処理し、配信する `runtime` モジュールには SQL lexer / parser を含めない。文脈上の `lxt` は LTX として実装した。

## 試す

Node 24+、MoonBit CLI、pnpm、just が必要。ネイティブ検証には Go 1.26+ と Litestream v0.5.18 を使う。

```sh
just build-lite
pnpm exec vite preview
# http://127.0.0.1:14173/lite/?client=notes

just compile-sql examples/notes/catalog.json examples/notes/program.generated
just aot-check /absolute/path/to/litestream
just measure-aot
```

`just build-lite` は AOT デモだけを配信する。`just build` は従来の同期デモと AOT デモを両方ビルドする。AOT のページと専用 Service Worker は `/lite/` にある。保存、再読込、LTX の生成・ダウンロードをネットワークを切って試せる。

元の SQL は [catalog.json](../../examples/notes/catalog.json)。ビルド CLI は次を生成する。

| 成果物 | 内容 |
| --- | --- |
| `.json` | 形式 `moon-aot@1` のクエリ AST・固定スキーマ・空 SQLite テンプレート・物理レイアウト |
| `.manifest.json` | artifact / source / template の SHA-256、native SQLite の版、bind 数と列名 |
| `.ts` | artifact と manifest の定数。ブラウザから import するデータのみのモジュール |

SQL の解析・妥当性検査は MoonBit 製コンパイラーが行う。空の SQLite スキーマテンプレートと root page・物理列順・collation はビルド時に Node SQLite で確定する。暗黙 index の命名や順序を実行時に再計算する必要がなくなる。行・B-tree・overflow・SQLite record・LTX の生成は MoonBit が行い、Native SQLite はブラウザの依存にしない。

## MoonBit の公開 API

`moon.pkg` から `"mizchi/sqlike"` を import して `@sqlike` を使う。コンパイラーは `mizchi/sqlike/compiler`、ブラウザ用の SQLike + LTX 統合は `mizchi/litestream-example/runtime` にある。

[moonbit-community/sqlite3.mbt の column.mbt](https://github.com/moonbit-community/sqlite3.mbt/blob/main/column.mbt) と、関連する bind / stmt / value / connection を参照した。`Connection` / `Statement`、`Bind` / `Column`、`Value` の型付きインターフェースを使う。

```moonbit
// program_json はビルド成果物。get は固定カタログ内の名前。
let program = @sqlike.Program::load(program_json)
let db = @sqlike.Connection::from_program(program)
let statement = db.prepare_compiled(program.query("get"))
statement.bind(index=1, 9007199254740993L)
if statement.step() {
  let id : Int64 = statement.column(index=0)
  let title : String = statement.column(index=1)
  ignore((id, title))
}
statement.reset() // bind は維持。clear_bindings=true で NULL に戻す。
statement.finalize()
db.close()
```

bind は1始まり、column は0始まり。`Int64` / `Double` / `String` / `Bytes` と `Value::{Null,Integer,Real,Text,Blob}` を扱う。型変換して取り出した後も、`Column[Value]` は元の storage class を返す。現行行がない状態・範囲外・finalize 後の操作はエラーにする。生きている Statement がある接続の close は Busy。finalize は繰り返せる。

`Connection::open(":memory:")` と SQL 文字列の `prepare` は開発用。固定 Program の接続は SQL 文字列を拒否し、`prepare_compiled` を使う。別 Program の Query も拒否する。参照実装の全 async API・C ABI・エラーコードを実装したという意味ではない。[型付き API の実行テスト](../../packages/sqlike/src/full/interface_test.mbt)が契約例になる。

## ブラウザの保存と LTX

[AotDatabase](../../adapters/aot-database.ts) は専用 Worker 内で動作する。JS の `bigint` を INTEGER、`number` を REAL として bind する。負のゼロと int64 を数値丸めで失わずに渡す。

書込は非公開の DB clone で評価し、保存が成功してから公開する。通常更新は変更後の行だけを保存し、checkpointの位置・base SQLite・未確認LTXの変更も同じIndexedDB transactionで確定する。baseとLTXは差分保存時にはバイナリ添付にし、定期スナップショットでは互換形式を使う。[保存契約と方式比較](indexeddb-persistence.md)を参照。世代番号による CAS と `strict` durability を使い、別タブの古い書込、保存 abort、commit 後の応答喪失を検証した。確定状態が不明な接続は再読込を要求する。

`checkpoint()` は初回 snapshot、以降は変更ページの LTX を作り、送信候補として永続化してから返す。未変更時は新規ファイルを作らない。`pending()` で得たファイルを復元先が受理した後、同じ TXID とファイル SHA-256 を `acknowledge()` に渡して outbox を削除する。ダウンロード自体を ACK とは扱わない。

**[R02でNode relay / DOの保存gatewayへの送信を接続した](aot-ltx-upload.md)。** `sync(endpoint)`は最新checkpointと未確認LTXを順番に送る。通信前に履歴の所有者・送信先・Programを永続化し、同じTXIDとファイルhashのACKだけを確定する。ACK消失後の再送と、サーバーから取得したファイルの本家復元を検査した。従来の SQL / Session / LTX 受信同期は元のデモにある。物理 LTX は一つの履歴・base checksum に属し、複数のオフライン writer のページ差分を意味的にマージする仕組みではない。

## 検証範囲

- MoonBit が更新した DB から、通常 table・index・WITHOUT ROWID の leaf / interior、overflow、全整数幅、UTF-8・BLOB を書き出す。512 / 4,096 / 65,536 bytes のページを native SQLite の `integrity_check` と値で検査する。AUTOINCREMENT の0を挿入して全削除した履歴も保持する。
- LTX は snapshot / delta / shrink / no-op / uint64 TXID を上流 Go decoder で検査し、本物の Litestream で復元する。復元ファイルは入力 SQLite とバイト単位で比較する。
- AOT の JS / Wasm GC は、上流 `select1.test` の全1,000問い合わせで元の期待値・MD5・native SQLite の型付き結果と照合する。元データの SHA-256 も検査し、失敗 SQL を除外しない。
- JS / Wasm GC で同一の SQLite / LTX bytes を生成する。Wasm に外部 DB import がないこと、JS とブラウザの Worker に SQL lexer / parser がないことも検査する。開発用 SQL engine を拒否する負の対照もある。
- Playwright で、他 DB SDK の取得を禁止した状態のオフライン書込・再読込、実 IndexedDB の競合、ブラウザ産 LTX の本家復元を確認する。
- Node relay / 実workerdのDOへのアップロードで、受信直後のACK消失、再起動と同じbytesの再送、別publisherの拒否も確認する。

事前生成された artifact は信頼するアプリのビルド入力。同期相手が任意の SQL IR を送信する API にはしない。保存イメージは Program と固定スキーマの一致、行と制約を検査する。Program は1 MiB / 1,000 queries、DB / LTX は64 MiBが上限。SQLite 全機能の互換性は[未達](sqlite-feature-audit.md)。DDL は再ビルドを必要とし、旧 Program の保存イメージを新 Program に自動移行しない。

ページ出力は checkpoint ごとに全体を再構築する。更新量に比例する SQLite の pager / WAL writer、永続検索 index、上限内の全入力で高速に動く保証はない。サイズと速度の比較は [AOT 計測結果](aot-performance.md)を参照。
