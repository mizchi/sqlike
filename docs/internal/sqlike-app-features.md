# 一般的なアプリ向けの追加機能

現行の再計測は[P0結果](p0-results.md)を参照。以下は以前の実装・計測の記録である。

現在の実装状態と改善対象は[対応範囲と改善台帳](status-and-improvement-plan.md)を参照。このページの追加時点の測定・テスト件数は履歴として残す。

0.0.1に、SQLトランザクション、CAST、複合SELECT・INSERT SELECT、JSON、UTC日時、外部キーの拡張、スキーマ移行、集約・window、再帰CTEと任意の全文検索モジュールを追加した。0.1.0への昇格は[利用シナリオ全体の条件](roadmap-0.1.0.md)を満たしてから行う。SQLite全機能互換の宣言ではない。

## SQLと実行契約

| 機能 | 今回の対応 |
| --- | --- |
| トランザクション | BEGIN / COMMIT / END / ROLLBACK、SAVEPOINT / RELEASE / ROLLBACK TO。重複したsavepoint名、失敗した文の取消とトランザクション継続 |
| 型変換 | CASTのINTEGER / REAL / TEXT / BLOB / NUMERIC affinity。数値prefix、指数、int64の飽和、NULL |
| 複合SELECT | UNION / UNION ALL / INTERSECT / EXCEPT、最終ORDER BY・LIMIT、左右のalias解決、NULL・collationの集合比較 |
| コピー | INSERT … SELECT、自己コピー時の読み取り範囲の固定、RETURNING、失敗時の文全体rollback |
| JSON | json_valid、json / json_quote、json_extract / json_type、json_array / json_object / json_array_length、json_set / json_insert / json_replace / json_remove / json_patch |
| UTC日時 | date / time / datetime / julianday / unixepoch / strftime、ISO日時・offset・Unix / Julian入力、基本modifier、月・年のfloor / ceiling、ISO週、CURRENT_DATE / CURRENT_TIME / CURRENT_TIMESTAMP |
| 外部キー | 複合FK・暗黙の親PK、ON UPDATE CASCADE、ON DELETE CASCADE / SET NULL / SET DEFAULT / RESTRICT / NO ACTION、DEFERRABLE INITIALLY DEFERRED |
| 移行 | テーブル名変更・列名変更・列削除。FK・index・view・triggerの参照と保存DDLを更新し、参照が残る列の削除は拒否 |
| 集約 | group_concat / string_agg、COUNT / SUM等とgroup_concatのDISTINCT引数 |
| window | PARTITION BY、lag / lead、row_number / rank / dense_rank / percent_rank / cume_dist / ntile、first_value / last_value / nth_value、集約の累積・移動frame |
| 再帰CTE | WITH RECURSIVE、CTE列名、VALUES seed、行queue、UNION重複排除、LIMIT / OFFSET |

新しいSELECT・DMLは動的JS / Wasm GC、AOT JS / Wasm GCから同じMoonBit実行器を使う。AOTではparserを配信しない。新しいoptional AST metadataを使わない既存programのJSON表現を維持する。DDLの移行は動的SQLまたはビルド時のschema更新で行い、AOTの固定schemaをその場で別schemaに読み替えない。

### トランザクションと保存

```sql
BEGIN;
INSERT INTO tasks(id,title) VALUES(1,'draft');
SAVEPOINT optional;
UPDATE tasks SET title='trial' WHERE id=1;
ROLLBACK TO optional;
RELEASE optional;
COMMIT;
```

各文を順に実行する。MoonDatabaseとAotDatabaseは、SQLトランザクション中の状態をIndexedDBへ確定しない。COMMIT / 最外SAVEPOINTのRELEASEが成功した後にまとめてstrict commitする。COMMITのACK消失後は再読込を要求し、確定結果を再実行しない。接続を閉じて未確定状態を捨てた後の再開は、最後の保存状態になる。

これは接続内の論理トランザクションで、ネイティブVFSのDEFERRED / IMMEDIATE / EXCLUSIVEロックの再現ではない。異なる保存接続間の競合は既存の世代CASで拒否する。ネットワークSQLのlexerは引き続きトランザクション制御を拒否し、outbox・receiptとアプリの更新をまとめる既存の同期契約を維持する。

### JSON・日時・windowの境界

JSONはRFC JSONを基本に、入れ子・配列index・`[#-N]`・`[#]`、SQL NULLとJSON null、文字列とJSON構造の値を区別する。[差分修正](sqlite-differential-findings.md)で順序・重複キーを保持するSQL専用JSON木へ変更済み。json_validに加え、最初のキーの抽出・編集・削除、json_objectの重複label、patchをnativeと照合する。初期実装の「重複キーを拒否する」という制約は解消した。JSON5 / JSONB、table-valuedなjson_each / json_treeは未対応。

日時の計算はホストのDateやローカルtimezoneに依存しないGregorian / UTC計算。現在時刻はhostが文ごとに注入する。TSのMoonDatabase / AotDatabaseは自動で設定し、MoonBit Connectionの利用側は`set_clock(milliseconds)`を呼ぶ。直接JS / Wasm APIでは`database_set_clock(db, millisecondsString)` / `aot_set_clock(db, millisecondsString)`を使う。時刻は保存画像に含めず、挿入した値は通常のデータとして保存する。同期する更新には確定した時刻をbindする方針を維持する。localtime / utcによるホストtimezone変換、timediffと全modifier組合せの互換性は未対応。

windowはROWS / RANGE / GROUPSを扱い、offsetは非負整数の対応範囲に限定する。0.1.1では`aggregateFilter`を選ぶと集約FILTERも利用できる。named WINDOW、EXCLUDEなど全構文の互換性は未達。再帰CTEの優先queueを指定する内部ORDER BYも未対応で、黙って異なる探索順にはしない。再帰の結果・queueは100,000行上限。

## 任意の全文検索

`mizchi/sqlike/fts`とTSの[src/search.ts](../../src/search.ts)を追加した。通常のSQLike・AOTアプリからimportせず、配信サイズへ合算しない。既存のLSM実験も引き続き通常バンドルから除外する。

```ts
import { SearchIndex } from './src/search.ts';

const search = new SearchIndex(['title', 'body'], 'trigram');
search.rebuild(db.query('SELECT id,title,body FROM documents').map(row => ({
  rowid: row.id as bigint,
  fields: [String(row.title), String(row.body)],
})));
const hits = search.search('データベース', 20);
// [{ rowid: 1n, rank: ... }]。負のBM25値の昇順、同点はrowid順。
```

転置indexと位置を保持し、ascii / trigram、単語・phrase・prefix、AND / OR / NOT・括弧・列filter、BM25を実装した。putで同じrowidを置き換え、delete、dump / restore、候補を検証してからのrebuildに対応する。SQLite FTS5で同じtokenizerを指定し、JS / Wasmの検索結果とrankを比較する。

**FTS5のCREATE VIRTUAL TABLE / MATCHというSQL構文や、shadow tableのファイル形式を実装したものではない。** このindexはSQLテーブルから再構築する派生状態で、SQL・LTXには元の文書を保存する。commit・同期・再読込後に確定データからrebuildする。indexへのputとSQL更新を別々に行って、両方が原子的だと扱わない。

unicode61 / porter、NEAR、snippet / highlight、列ごとのrank重みなどは対象外。trigramはUnicode scalarの3文字単位で、短い検索語にはhitしない。case foldingには[SQLiteの公開Unicode fold table](https://github.com/sqlite/sqlite/blob/master/ext/fts5/fts5_unicode2.c)を移植した。生成元のSHA256と再生成スクリプトを[ソース](../../packages/sqlike/src/fts/unicode_fold.mbt)に残し、実行環境のUnicode版に依存させない。検索構文・tokenizer全体のFTS5互換は宣言しない。最大64列・100,000文書・保存用文書約64 MiBで、indexのposting用メモリは別に必要。全行を保持しないpagerではない。

## 検証と再現

```sh
LITESTREAM_BIN=/path/to/litestream just check
just sqlike-check
just sqlite-bench
just build-size
just measure-aot
just measure-search
```

- [4経路の共通比較器](../../tests/compatibility/sqlike-paths.ts)
- [CAST・JSON・日時](../../tests/sqlike-app-functions.test.ts)
- [トランザクション・複合SELECT・再帰CTE](../../tests/sqlike-compound.test.ts)
- [集約・window](../../tests/sqlike-window.test.ts)
- [複合FKと参照動作](../../tests/sqlike-foreign-actions.test.ts)、[移行・再読込](../../tests/sqlike-migration.test.ts)
- [新しいAST・FK・現在時刻defaultのSQLite round-trip](../../tests/sqlike-app-roundtrip.test.ts)
- [FTS5比較・再構築の原子性](../../tests/sqlike-fts.test.ts)
- [SQL COMMITのACK消失](../../tests/aot-persistence.test.ts)、[実IndexedDBでの未確定状態の破棄・再読込](../../e2e/sqlike-app-features.spec.ts)

MoonBit **40件×JS / Wasm GC**、Node **191件**、Playwright **43件**と型チェックが通過した。実LitestreamでのLTX復元を含む。全機能監査も3対象で再実行し、固定プローブ一致は **90 → 162件**、値の不一致は0件だった。未対応・未検証が残るため、全互換ゲートは意図通り失敗する。

追加前の[速度](../../measurements/sqlite-speed-before-app-features.json)・[ライブラリサイズ](../../measurements/wasm-build-size-before-app-features.json)・[実アプリ](../../measurements/aot-before-app-features.json)を固定して再測定した。AOTアプリの初回転送はBrotli **85.51 → 98.36 KiB**、AOT全公開APIのJS単体は **87.20 → 102.96 KiB**、Wasmは **109.74 → 127.88 KiB**。既存notes programの20,049 BとSHA256は同一。

任意の全文検索は、JS wrapper＋runtime単体がBrotli **36.61 KiB**、Wasm module単体が **46.68 KiB**。[検索の計測](../../measurements/search-current.json)を分離し、通常版・lite版の生成JSに混入しないことを検査した。

同じ1,000行の既存AOT処理では、主キー検索 JS **5.11 → 6.15 μs** / Wasm **4.90 → 5.90 μs**、範囲検索 **14.90 → 18.60 μs** / **11.88 → 13.97 μs**、更新 **6.15 → 8.28 μs** / **3.69 → 4.57 μs**を観測した。比較用SQLiteも約20〜27%遅くなっており、機能追加だけの費用とは断定しない。SQLike / SQLite比では主キー検索は追加前に近く、JS更新には約8%の比率増加がある。全156経路・1,092サンプルの結果検査と6 CPU profileを[速度レポート](../../measurements/p0-before/sqlite-speed-current.json)に残す。
