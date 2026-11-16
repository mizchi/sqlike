# MoonBit 製 SQL エンジン

現在の対応・明示拒否・実施済み最適化と、次の改善は[対応範囲と改善台帳](status-and-improvement-plan.md)に集約する。

`engine=sqlike` を実装した。SQL の解析、値、評価、制約、行ストア、SQLite Session 形式の差分生成と SQLite ファイル reader を `packages/sqlike/src/*.mbt` に新規実装している。`backend=ltx` の受信・展開・SQLite イメージの検査も MoonBit で行う。SQL を既存 SQLite に転送する処理や、未対応 SQL を別エンジンに渡す fallback はない。

[SQLike の開発方針](sqlike-development.md)に従い、速度と既存の差分テストを維持しながら SQLite 互換の SQL を拡張する。現在は SQLite の完全な移植ではない。互換性は `browser-sqlite@1` の **42 ケース・842 ステップ**に加え、[本家 sqllogictest 1,000件・生成式7,776件・REAL 文字列化528件](sqlite-conformance.md)を native SQLite と照合する。JS / Wasm GC / Chromium で同じ入力を検証する。既存の SQLite engine も選択でき、既定値は引き続き `sqlite`。

[全機能の監査](sqlite-feature-audit.md)では SQL 文・関数・PRAGMA・C API・拡張・障害要件を広げて検証し、全互換は未達と確認した。`just sqlite-audit` は未対応や未検証を含む現状で成功しない。

事前コンパイルした SQL と固定スキーマを使う [AOT 経路](aot-ltx-plan.md)も追加した。こちらは parser を配信せず、MoonBit で SQLite ページと LTX を生成する。`/lite/` は既存の同期デモとは別の入口になる。

## 実行

```sh
just build
just relay
# 別ターミナル
pnpm exec vite preview
```

```text
http://127.0.0.1:14173/?backend=node&engine=sqlike&room=moon-demo&client=a
http://127.0.0.1:14173/?backend=do&engine=sqlike&room=moon-demo&client=b

# ブラウザを正本にする構成
http://127.0.0.1:14173/?backend=peer-do&engine=sqlike&room=moon-peer&client=host&role=host
http://127.0.0.1:14173/?backend=peer-do&engine=sqlike&room=moon-peer&client=a
```

ブラウザでは MoonBit JS backend を使う。COOP / COEP が必要で、Vite の dev / preview は設定済み。SQLite / Turso のアダプターは別 chunk に分け、選択したエンジンだけをロードする。MoonBit の起動・オフライン再読込で SQLite Wasm と Turso を取得しないことを Playwright で検査する。

```sh
just diff-moon  # 実ブラウザで SQLite と 842 ステップを比較
just moon-wasm # SQL / LTX コアを standalone Wasm GC にビルド
LITESTREAM_BIN=/absolute/path/to/litestream just check # Go も必要
```

SQL と LTX の実装には `extern "js"` / `#external` がなく、Wasm GC 版にも実際の API を export している。Node 24 で JS string builtins を指定して instantiate し、同じ842ステップ・変更証明を検査する。別のテストでは実 Litestream の LTX を Wasm GC で展開し、その SQLite イメージを SQL で問い合わせる。Wasm GC の byte array が host から opaque な場合には、pure MoonBit の base64 ABI を使う。ブラウザの `engine=sqlike` は JS 版を使用する。

## サイズ

P0の現行計測ではSQL文字列版アプリがBrotli **163.77 KiB**、parserを配信しないAOTアプリが **106.98 KiB**。ライブラリ単体の全exportの容量とは分けて扱い、アプリ転送に合算しない。任意の全文検索とLSMは含まない。[現在の結果と条件](p0-results.md)、[以前の計測](runtime-size.md)、[実行最適化の履歴](sqlike-optimization-plan.md)、[Web標準による削減試作](web-platform-size.md)を参照。

最新の[追加SQL・保存境界・制約と任意の全文検索](sqlike-app-features.md)を別記する。

## 現在検証している SQL

| 範囲 | 内容 |
| --- | --- |
| 値と比較 | NULL、符号付き int64、REAL、TEXT、BLOB、column affinity、三値論理、UTF-8 BINARY / ASCII NOCASE |
| 式と部分問い合わせ | CAST、CASE、BETWEEN、IN / IN サブクエリ、EXISTS、スカラー・相関サブクエリ、TRUE / FALSE |
| DML | INSERT SELECT、INSERT / 複数 VALUES / OR IGNORE / OR REPLACE、UPDATE、DELETE、bind、UPSERT、RETURNING |
| 制約 | PRIMARY KEY、NOT NULL、UNIQUE、CHECK、複合FK、参照動作、遅延制約 |
| テーブル | 通常 / STRICTテーブル、INTEGER PRIMARY KEY、AUTOINCREMENT、複合主キー、WITHOUT ROWID |
| 問い合わせ | SELECT、UNION / INTERSECT / EXCEPT、WHERE、ORDER BY、LIMIT / OFFSET、DISTINCT、INNER / CROSS / LEFT / RIGHT / FULL JOIN、GROUP BY、集約・window、再帰CTE |
| DDL | CREATE / DROP TABLE、複合・降順・部分・式 INDEX、基本 TRIGGER、VIEW、ALTER ADD / DROP COLUMN・RENAME TABLE / COLUMNと依存の更新 |
| 関数 | changes / last_insert_rowid、coalesce / ifnull、typeof、hex、length、ASCII lower / upper、abs、substr / substring、instr、replace、trim / ltrim / rtrim、concat / concat_ws、octet_length、nullif、iif / if、JSON抽出・更新・構築、UTC日時関数 |
| 同期の内部契約 | sqlite_schema、列・FK の introspection、schema cookie、データと outbox の原子更新 |

この表は各機能の全構文・全組み合わせの保証ではない。SQL の準備段階を評価から分離し、未知の列や未対応関数を空テーブルの UPDATE / RETURNING / UPSERT でも検出する。スカラー関数は準備段階では実行しない。未対応文や制約違反は文全体をロールバックする。バッチの失敗では DDL・行・メタデータもまとめて戻す。

対応を追加するときは、まずネイティブ SQLite に同じ入力を流した差分テストを追加する。oracle の予期しない失敗はテスト失敗にし、双方が失敗しただけでは合格にしない。既存のプロファイルは縮小していない。

## 保存とトランザクション

SQL の評価は DB Worker 内で同期的に完結する。保存専用 Worker は IndexedDB の `browser-litestream-moonbit-<client>` に、論理checkpointと変更行ジャーナルを保存する。テーブル、ローカル revision、outbox、receipt、解決履歴の変更を同じtransactionで確定する。[保存契約と方式比較](indexeddb-persistence.md)に詳細を記す。

保存は一つの readwrite transaction 内で世代番号を読み、期待する世代との一致を検査してから put する。`strict` durability を要求し、成功応答は transaction の `complete` 後に返す。同期 DB API との橋渡しに使う SharedArrayBuffer は **4 KiB** で、DB イメージそのものを置く共有領域ではない。

- put 後の失敗は transaction を abort し、前のイメージを保つ。
- 同じ世代からの並行更新は一方だけを受理する。古い接続は再読込を必要とする。
- 10秒の timeout や保存応答の不整合では、確定したかどうかを推測しない。接続を使えなくし、再読込後に保存状態を確認する。
- 再読込では形式、DDL と列構造、行の長さ、rowid、一意制約、NOT NULL / CHECK / FK を検査してから接続を公開する。
- 未確定のコミットをアプリの競合解決で上書きしない。既存の guard / policy / receipt / 重複排除の契約を使用する。

IndexedDB のキー比較で SQL を代用しない。整数の精度や文字列の比較順序は MoonBit の値層が扱う。

## バイナリ差分と物理形式

MoonBit が生成した INSERT / UPDATE / DELETE の差分を、Node のネイティブ SQLite Session API へ実際に適用して照合する。主キーを変えた更新は DELETE + INSERT として表す。binary modeは非NULLの宣言済み主キーを持つ通常テーブルが対象で、DDLはSQL経路を使う。trigger / FK付き適用は任意の[副作用抑制wrapper](sqlike-feature-profiles.md)で有効にし、wrapperなしでは拒否する。受信した差分は MoonBit decoder / old-value検査 / SQL適用計画を通す。

## pure MoonBit の LTX 接続

`engine=sqlike&backend=ltx` を使うと、サーバーから Litestream が生成した LTX v3 を受信し、MoonBit の LZ4 / CRC64 / page-index 検証・ページ適用を経て、SQLite イメージを MoonBit で読む。サーバーの論理 snapshot / restore gateway とブラウザの SQLite WASM は使わない。

```text
http://127.0.0.1:14173/?backend=ltx&engine=sqlike&room=pure-ltx&client=a
http://127.0.0.1:14173/?backend=ltx&engine=sqlike&room=pure-ltx&client=b
```

```sh
# Litestream の実行ファイルを必須にして、skip せず実 E2E を行う
just ltx-moon /absolute/path/to/litestream
```

サーバーの正本はネイティブ SQLite であり、上りは既存の SQL / Session changeset、下りが LTX になる。MoonBit engine が自分で WAL / LTX を生成する経路ではない。

ファイル reader は [SQLite の file format](https://www.sqlite.org/fileformat2.html) に従い、次を扱う。実装は [sqlite_file.mbt](../../packages/sqlike/src/sqlite_file.mbt) と [sqlite_import.mbt](../../packages/sqlike/src/sqlite_import.mbt)。

- 512〜65,536 bytes のページ、table / index の leaf と interior を読む。WITHOUT ROWID は interior のレコードも含め、主キーを先頭にした物理列順を宣言順に戻す。
- 1〜9 bytes の varint、signed rowid、各整数幅、REAL、TEXT / BLOB、overflow chain を読む。REAL affinity の整数格納や ALTER ADD 後の省略列も戻す。
- UTF-8 / UTF-16LE / UTF-16BE を復号する。BINARY は DB の文字コードのバイト順、NOCASE / RTRIM は UTF-8 の collator を使い分ける。
- freelist と auto-vacuum の pointer map を検査する。セル・freeblock の範囲と重なり、fragment 数、循環・共有ページ、レコード長、B-tree の高さと順序、index とテーブルの内容、未参照ページを確認する。
- sqlite_schema を元に列・制約・index / view を再構成し、AUTOINCREMENT の sqlite_sequence も読む。全候補を検証してから接続を置き換える。

対応SQLの範囲を超えるschemaや、壊れた文字列・ページは明示的に拒否する。Infinityの物理画像往復は差分検査済みだが、同期Cellの非有限REALは別契約で拒否する。SQLiteの`quick_check`と検査項目が完全に同じという保証ではなく、SQLikeの同名PRAGMAは明示拒否する。任意のhot WAL / journal付きDBを復旧するreaderではなく、LTXを検証・適用して完成したcommitted image、または同等の完全なSQLiteファイルを入力とする。

確定した生の SQLite イメージは IndexedDB の `browser-litestream-image-cache-moonbit-<client>` に保持する。候補のバイナリ保存が完了してから、cursor・ローカルの論理データ・revision・outbox を差分ジャーナルへ原子的に確定する。旧OPFS画像は遅延フォールバックから移し、新規DBではfilesystem APIを要求しない。候補とcursorは別の保存領域なので、確定後に古い候補を回収する手順を維持する。

実 E2E では snapshot / replica API と SQLite WASM / Turso のダウンロードを遮断し、LTX 経由の int64 / REAL / overflow BLOB、オフラインでの binary 更新、再読込、増分同期、二つのブラウザの収束を確認する。対象が一意でない SQL は利用側の `select-note@1` が主キーで解決し、選ばれた行だけが変更された結果と `resolved` receipt を LTX 経由で確認する。破損転送では前の cursor と ACK 済み outbox を保ち、再読込後の再送・orphan 削除・欠落イメージの再取得を検証する。保存の ACK が失われた場合も、再読込後に cursor・データ・outbox が同じ確定状態として現れる。

**作業 DB の永続形式は引き続き MoonBit の論理イメージ。** この従来経路にはローカル SQL を確定 SQLite へ書き戻す処理はない。新しい AOT 経路には B-tree / SQLite writer があり、独立した LTX 履歴を出力する。WAL writer は未実装。取得した確定イメージへ未同期の編集を直接上書きしない。

## 規模と未対応範囲

行ストアはメモリ内の配列であり、単一列・複合列の前後方向の検索には実行用のソート済み索引を保持する。[部分 / 式 index と基本 trigger の制約](sqlike-index-trigger.md)を別記する。永続検索B-treeではなく、その他の検索や一意制約・一部のJOINには走査や二乗のコストが残る。文の退避は可変コンテナーを複製する。通常のdurable commitは変更行だけを保存し、定期checkpointやschema変更では全量画像を書き出す。コードサイズの小ささと大規模 DB の速度は別の指標である。

現状は SQL 1 MiB、10,000 tokens、式の深さ64、SELECT / VIEW の深さ16、テーブル・中間結果と各物理 B-tree100,000行、レコード2,000列、durable / SQLite image 64 MiB を上限とする。上限内の全入力が高速に実行できるという保証ではない。

INSTEAD OF / TEMP trigger、仮想テーブルのSQL構文、拡張ロード、ATTACH、SQLite の全組み込み関数・window構文、任意の ALTER、全形式の SQLite ファイル書き込み互換性、query-plan 互換性は未対応。AOT writer の検証範囲は別記する。Firefox / WebKit の動作も未検証。完全な SQLite 互換を名乗らず、テスト済みのプロファイルを拡張していく。

## コードと測定記録

- [値と状態・公開 ABI](../../packages/sqlike/src/model.mbt)、[parser](../../packages/sqlike/src/parser.mbt)、[準備](../../packages/sqlike/src/prepare.mbt)、[値の意味](../../packages/sqlike/src/value.mbt)
- [評価器](../../packages/sqlike/src/evaluate.mbt)、[問い合わせ](../../packages/sqlike/src/query.mbt)、[変更と制約](../../packages/sqlike/src/execute.mbt)、[changeset](../../packages/sqlike/src/changeset.mbt)、[再読込の検査](../../packages/sqlike/src/image.mbt)
- [共通 Database アダプター](../../adapters/moon-database.ts)、[IndexedDB](../../adapters/moon-image-store.ts)、[保存 Worker](../../adapters/moon-persistence-worker.ts)
- [物理 reader の SQLite 差分テスト](../../tests/sqlite-file.test.ts)、[Wasm GC の LTX → SQL テスト](../../tests/moon-ltx-wasm.test.ts)、[実 LTX のブラウザ E2E](../../e2e/moon-ltx.spec.ts)
- [ブラウザ互換性結果](../../measurements/compatibility-chromium-moonbit.json)、[ランタイム測定](../../measurements/runtime-current.json)
