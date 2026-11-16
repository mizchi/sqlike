# 本家 SQLite との SQL 差分テスト

MoonBit の SQL エンジンを native `node:sqlite` と直接比較する。同期ポリシーや SQL の安全性判定を通さず、同じ SQL を両者へ入力する。既存のブラウザ同期プロファイル42ケース・842ステップも継続して検証する。

[全機能の互換性監査](sqlite-feature-audit.md)も追加した。本ページの固定コーパスは合格しているが、広い機能一覧では本家が受理する SQL の拒否が残り、全互換の判定は失敗する。

```sh
just conformance
just sqlike-check

# 同期・永続化・LTX を含む全チェック
LITESTREAM_BIN=/absolute/path/to/litestream just check
```

`just conformance` は MoonBit の JS / Wasm GC をビルドし、Node と実際の Chromium で実行する。本家の結果を取得できない SQL や、候補の未対応 SQL を除外して合格させる処理はない。不一致はコマンドの失敗になる。

## 固定した入力

| 入力 | 数 | 比較する内容 |
| --- | ---: | --- |
| 本家 sqllogictest の `select1.test` 全体 | 準備31文・問い合わせ1,000件 | 元の期待値・MD5、および native SQLite の型付き結果 |
| 固定生成の式 | 7,776件 | 値・storage class・列位置・結果順序 |
| REAL → TEXT | 528件 | 境界値と固定 seed の有限 double の文字列化 |
| 文字列・条件関数の固定生成入力 | 3,970件 | Unicode、NUL、BLOB、int64 境界、NULL、遅延評価。JS / Wasm GC / AOT / Chromium |
| 準備・実行時の失敗 | 11件 | エラー分類、失敗後の行が変更前と一致すること |

上流データは [SQLite sqllogictest プロジェクト](https://www.sqlite.org/sqllogictest/)のテストである。公式 raw URL が取得時に browser verification を返したため、公開ミラーの commit `c93ac416f05635ff5cc490009add936d9753d01d` に固定して取得した。ファイルは一切変更せず、SHA-256 `e93b83d64d06f78aee0e690455b6c604e86ad9a339f77d927a782cefb6b0e1d5` をテストで検査する。[取得元・ライセンス](../../tests/fixtures/sqllogictest/upstream.json)と[元ファイル](../../tests/fixtures/sqllogictest/select1.test)をリポジトリに含める。

元の sqllogictest は出力値を正規化して比較するため、それだけでは INTEGER と REAL の違いや重複した列名の欠落を検知できない。この実装では列位置で取得した結果も比較し、INTEGER は BigInt、REAL は number、BLOB はバイト列として扱う。候補の結果を native 側の型へ丸めて合わせる処理は行わない。比較器が改変した期待ハッシュを拒否すること、未知の directive を無視しないことも検査する。

今回選んだ上流ファイルはすべて `I` / `nosort` で、engine 固有の skip directive は含まない。任意の sqllogictest directive をすべて実装したランナーという意味ではない。

## 実装で修正した差

- 単純 CASE / 検索 CASE、BETWEEN / NOT BETWEEN、スカラーサブクエリ、EXISTS、IN サブクエリと相関参照を追加した。未選択の分岐でも名前と列数を準備時に検査し、値の評価は必要な分岐に限定する。
- NULL と空集合の扱い、TRUE / FALSE と同名の列、`IS TRUE/FALSE` の真偽値比較を合わせた。
- DISTINCT の数値比較・照合順序と、ORDER BY の列位置指定で継承する collation を修正した。
- 負のゼロ、int64 の剰余演算、REAL の文字列化を修正した。文字列化は SQLite 3.53 の [`sqlite3FpDecode`](https://github.com/sqlite/sqlite/blob/version-3.53.4/src/util.c) と [`vdbemem.c`](https://github.com/sqlite/sqlite/blob/version-3.53.4/src/vdbemem.c) に対応する数値変換を pure MoonBit で行う。

SQL を既存 SQLite へ転送する fallback は持たない。Wasm GC は DB ホスト関数なしで instantiate し、Chromium の直接検証では SQLite WASM / Turso の取得がないことも検査する。

## 結果と保証の範囲

照合先は Node 24.22.2 に含まれる **SQLite 3.53.4**。各実行で `sqlite_source_id()` を記録する。JS、Wasm GC、Chromium JS の記録は以下に保存し、全ケースの成功後にのみ更新する。

- [JS](../../measurements/sqlite-conformance-js.json)
- [Wasm GC](../../measurements/sqlite-conformance-wasm-gc.json)
- [Chromium](../../measurements/sqlite-conformance-chromium.json)
- [同期プロファイルの Chromium / MoonBit](../../measurements/compatibility-chromium-sqlike.json)

本家のテストスイート全体や、SQLite 全文法の互換性を保証する結果ではない。対象は上記の固定入力と記録したエンジン・バージョン・実行環境である。この記録後に[index・trigger](sqlike-index-trigger.md)、AOT の SQLite writer、[CAST・再帰CTEなどの一般アプリ向けSQL](sqlike-app-features.md)を実装し、別の native 差分テストを追加した。仮想テーブルのSQL構文、SQLite 全組み込み関数などは引き続き未対応。[エンジンの実装範囲](moon-sql.md)を参照。
