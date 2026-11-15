# mizchi/sqlike

現在は **0.1.0**。[index・trigger](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/sqlike-index-trigger.md)、[SQLトランザクション・CAST・JSON・日時・window・再帰CTE・移行](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/sqlike-app-features.md)を実装済み。全文検索は任意の `mizchi/sqlike/fts` に分離し、通常バンドルには含めない。一般的なアプリの利用シナリオと永続化・同期の必須プロファイルを検証した。[対応計画・完了条件](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/roadmap-0.1.0.md)を参照。

[機能選択プロファイル](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/sqlike-feature-profiles.md)でRIGHT/FULL JOIN、STRICT、主キー索引、trigger、FKなどを選択し、JS/Wasmを生成できる。AOTはパーサを含まない。binaryの副作用適用は別entryの任意wrapperで有効にする。

MoonBit 製の SQLite サブセット。値・SQL parser・評価・制約・行ストア、SQLite ファイルの読取・出力を持つ。`mizchi/litestream` に依存せず利用できる。[開発方針](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/sqlike-development.md)に従い、速度と既存の互換性を維持しながら SQLite の対応範囲を広げる。全機能の互換性は未達。

| パッケージ | 用途 |
| --- | --- |
| `mizchi/sqlike` | `Connection` / `Statement` / `Bind` / `Column` / `Value`、事前コンパイルした `Program`、DB イメージと SQLite ページ |
| `mizchi/sqlike/compiler` | ビルド時の `compile_program`。SQL 文字列を解析して固定スキーマとクエリ AST を生成 |
| `mizchi/sqlike/fts` | 任意の転置index・phrase / prefix / boolean検索・BM25。通常のSQL runtimeから独立 |

利用する `moon.pkg` から `"mizchi/sqlike"` を import し、`@sqlike.Connection::open(":memory:")` または `Connection::from_program` を使う。bind は1始まり、column は0始まり。型付き API は [sqlite3.mbt](https://github.com/moonbit-community/sqlite3.mbt/blob/main/column.mbt) を参考にしている。

リポジトリの `moon.work` ではローカルソースから解決する。`just sqlike-check` で native SQLite との直接差分、`just sqlike-bench` で速度を検査する。ルートで `just test-sqlike` を実行すると JS / Wasm GC のモジュールテストを行う。外部ワークスペースからの利用も [consumer test](https://github.com/mizchi/sqlike/blob/v0.1.0/tests/workspace.test.ts) で確認する。

ブラウザの parser を除外した実行モジュールは `mizchi/litestream-example/runtime` が構成する。[SQL の検証範囲](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/moon-sql.md)、[AOT の利用手順](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/aot-ltx-plan.md)を参照。

`moon.mod`に依存を追加する。

```moonbit
import {
  "mizchi/sqlike@0.1.0",
}
```
