# IndexedDB と SQLite 互換性の評価

現在は[行差分ジャーナルによるIndexedDB保存](indexeddb-persistence.md)を実装し、行差分とSQLiteページ差分の速度・メモリを比較している。保存契約とfactoryを分離したため、保存実装を差し替えられる。以下は実装を選んだ背景と初期試作の記録である。

## MoonBit engine の追加

その後、[MoonBit 製 SQL engine](moon-sql.md)を実装した。`engine=sqlike` は SQL・制約・行ストア・Session encoder を含み、Chromium で既存の42ケース・842ステップを変更証明まで照合した。さらに [本家 sqllogictest と生成式の直接差分テスト](sqlite-conformance.md)も追加している。保存層だけの958 bytesという試作値は、この engine 全体の容量ではない。最新の配信量は[ランタイムサイズ](runtime-size.md)、保存速度とメモリは[差分保存の比較](indexeddb-persistence.md)に記録する。

追加した [AOT 経路](aot-ltx-plan.md)では、固定スキーマから SQLite ページと LTX を生成して本家で復元する。[現在の計測](aot-performance.md)に配信量と速度を記録する。

以下の保存層・既存 VFS の評価は、その実装を選んだ背景である。その後 pure MoonBit の SQLite file reader と LTX 接続も追加した。既定の engine は SQLite を継続している。全 SQLite の互換性や、大規模 DB の性能を実証した結果ではない。

## 保存層を試作した時点の判断

IndexedDB の保存層は小さく実装できる。試作は非圧縮2,692 bytes、gzip 1,104 bytes、Brotli 958 bytesで、原子更新・世代番号による競合検出・失敗時のロールバック・再読み込みを実ブラウザで確認した。ただし SQL parser / evaluator、changeset codec、LTX reader は含まない。

**SQL の振る舞いまで SQLite 互換にする場合は、保存先を IndexedDB にするだけでは足りない。DB 全体を明確に軽量化できたという証拠はまだないため、既定の SQLite WASM は変更しない。**

| 方式 | 実装・検証の主な負担 | サイズについて判明したこと |
| --- | --- | --- |
| 既存 SQLite の保存先を IndexedDB にする | 非同期 VFS、durability、競合、クラッシュ回復、既存アダプターとの接続 | SQL engine の Wasm が残る |
| IndexedDB + 自作 SQL evaluator | SQL 構文、型 affinity、NULL、int64、照合順序、制約、JOIN / 集約、計画・index | 保存層は958 bytes。SQL engine を含む総容量は未計測 |
| 限定した SQL プロファイルから実装する | 対応構文の明示、未対応文の実行前拒否、SQLite oracle による差分検証 | 軽量化の候補。互換範囲を縮小した効果と実装方式の効果を混同しない |

## IndexedDB に任せられる部分と残る部分

IndexedDB は object store と index の保存、トランザクション内の原子更新を提供する。一方、トランザクションは任意の非同期処理を待ち続けるものではない。イベントループに戻って inactive となり、要求がなくなると自動 commit の対象になる。今回の試作は request callback 内で読み取り・世代確認・put を行い、成功を返すのは transaction の `complete` 後に限定した。[IndexedDB のトランザクション仕様](https://www.w3.org/TR/IndexedDB-3/#transaction-lifecycle)

`strict` durability を要求し、ブラウザが `strict` と報告しなければ書き込まず中断する。この API 上の確認を、あらゆるハードウェア障害での永続性の証明とは扱わない。

SQL の index と IndexedDB の index はそのまま交換できない。実測でも、BigInt は IndexedDB のキーにすると `DataError` になり、文字列 `"\ue000"` と `"😀"` の順序は SQLite の BINARY collation と逆になった。int64 の値の保存と、SQL の比較順序を保った index キーは別の設計になる。[IndexedDB のキー](https://www.w3.org/TR/IndexedDB-3/#key-construct)、[SQLite の比較・型変換](https://www.sqlite.org/datatype3.html#comparison_expressions)

SQLite の NULL / 数値 / TEXT / BLOB、column affinity、整数と REAL の比較、UNIQUE の NULL の扱い等は SQL evaluator 側で再現する必要がある。SQLite ファイルや WAL の互換性も持たせるなら、さらに物理形式の検証が必要。今回の保存層試作はその機能を持たない。

試作はデータと outbox を一つの値にして保存するため、毎回スナップショット全体を clone / put する。小さなコードで原子性を調べるための方式で、大きな DB や大量の小さな更新で速いことを示すものではない。

## 互換性の担保方法

`browser-sqlite@1` を差分テストの単位として定義した。同じ操作列を native `node:sqlite` とブラウザ候補へ流し、次を比較する。

- SELECT の型付きの値。int64 は文字列、BLOB はバイト列として損失なく比較する。
- 更新件数、変更行、返り値、スキーマのハッシュ。
- UNIQUE / NOT NULL / CHECK / FK 等の安定したエラー分類。
- エラー後の問い合わせ結果と、バッチ全体の rollback。
- ORDER BY を指定した順序。順序未指定の SELECT は多重集合として比較する。

意図していない oracle の失敗はテスト自体の失敗にする。「両者が未実装で失敗したから互換」とは判定しない。故意に誤った結果を返す候補で、比較器が不一致を検出することもテストした。

現在は **42ケース・842ステップ、うち32個の固定 seed**。型・affinity・NULL・BLOB・Unicode・複合主キー・WITHOUT ROWID・UPSERT・RETURNING・制約・FK / CASCADE・JOIN・集約・window・CTE・DDL・JSON を扱う。生成ケースは小さな操作列の組み合わせであり、全 SQLite 文法の fuzzing ではない。

保証対象は、記録したプロファイル・入力ケース・バージョン・ブラウザの組み合わせ。Chromium の既存 SQLite backend と MoonBit engine でこのプロファイルを検証する。IndexedDB 保存層には SQL engine がないため、この SQL プロファイルの合格対象にはしていない。Firefox / WebKit や、未試験の SQL の互換性を合格済みとは扱わない。未対応機能を追加する際はケースも増やす。

```sh
just diff

# 別の登録済みブラウザエンジンを同じ条件で評価する場合
COMPAT_ENGINE=turso just diff
```

差分 E2E は既存の `just check` にも含まれ、不一致があればコマンドが失敗する。別エンジンがこのプロファイルに合格することは、既存の個別 E2E が通ることとは分けて判定する。

候補の既定値はアプリのエンジン定義と共有しているため、将来既定を変えると差分テストの対象も変わる。未知のエンジン名はエラーにし、SQLite へ暗黙に fallback して合格扱いにする経路は作らない。保存層だけの IndexedDB 試作は SQL engine として未登録。独立した SQL 実装は `moonbit` という名前で登録した。

この差分テストにより、従来のブラウザ SQLite 接続では外部キー違反をローカルで受理し、Node では拒否していた差を発見した。ブラウザ接続でも FK 検査を有効にし、snapshot 取り込みでは全テーブル・index を先に作成してデータを読み込み、FK 整合性を確認してから通常の検査へ戻すよう修正した。

## 既存 SQLite + IndexedDB VFS の候補サイズ

`@journeyapps/wa-sqlite@2.0.10` の配布 Wasm を実際に取得し、Brotli quality 11 で比較した。JS glue / IndexedDB VFS / アプリとの接続は含まないため、総配信サイズではない。

| 配布 Wasm | Brotli |
| --- | ---: |
| 現行 SQLite WASM | 344.6 KiB |
| wa-sqlite synchronous | 425.3 KiB |
| wa-sqlite Asyncify | 594.5 KiB |
| wa-sqlite JSPI | 303.6 KiB |

IndexedDB VFS は非同期の拡張なので、synchronous build の容量だけでは評価できない。[wa-sqlite の VFS 比較](https://github.com/rhashimoto/wa-sqlite/blob/master/src/examples/README.md)でも IndexedDB VFS には Asyncify / JSPI build を使う構成になっている。JSPI 版は対応環境の判定が必要で、容量差は現行の Wasm 本体に対して約41 KiB。今回確認した配布バイナリには Session / changeset API の export がなく、既存の生成経路をそのまま置換することもできない。SDK 全体の動作・互換性を認証した結果ではない。

既存 engine を残す方式では、今回の数値から大幅な軽量化を主張するのは難しい。自作 SQL engine を進める場合は、上記の差分テストを通した実装で、JS / Wasm / Worker / VFS を全部含む転送量と、代表データでの起動・メモリ・更新コストを再計測して採否を決める。

コード: [互換プロファイルと corpus](../tests/compatibility/corpus.ts)、[比較器](../tests/compatibility/contract.ts)、[ブラウザ差分テスト](../e2e/differential.spec.ts)、[保存層の試作](../adapters/indexeddb-store.ts)。

測定記録: [互換テスト結果](../measurements/compatibility-chromium-sqlite.json)、[保存層のサイズ](../measurements/indexeddb-store.json)、[Wasm 候補のサイズと SHA-256](../measurements/indexeddb-wasm-candidates.json)。
