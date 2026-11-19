# SQLite差分の修正と性能改善

現行の再計測は[P0結果](p0-results.md)を参照。以下は以前の実装・計測の記録である。

追記：[出力互換を優先する契約](sqlite-output-compatibility.md)を適用した。bare aggregate列、表現できないTEXT変換、未実装のintegrity_checkは明示拒否にし、DEFAULT宣言・返却境界のREAL型も修正した。以下の速度と容量は、この追記前の採取値である。

2026-11-15。監査で見つけた12項目を修正し、未対応だった演算子・関数・rowid書込みも追加した。元の500ケースに66件の回帰ケースを加え、**566ケース×8経路＝4,528件**を検証した。Node / Chromium、それぞれJS SQL / Wasm SQL / JS AOT / Wasm AOTを実行し、`just differential-audit`は成功する。失敗の除外リストは追加していない。

| 環境 | 実行結果一致 | 動作不一致 | 未対応 | AOTで双方のprepareが拒否 | AOT対象外DDL |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 24.22.2 / SQLite 3.53.4 | 2,256 | 0 | 0 | 4 | 4 |
| Chromium 158 / SQLite WASM 3.54.1 | 2,256 | 0 | 0 | 4 | 4 |

双方のprepare拒否は、FK親索引のcollation不適合と隠しrowidのUSINGで、AOT各2経路。実行一致へ合算しない。AOT対象外DDLはALTER TABLEで、動的JS/Wasmでは実行する。参照実装同士の観測差は0件。行・型・列位置に加え、失敗後の行、`changes()`、`last_insert_rowid()`も比較する。

[修正前の500ケース](../../measurements/sqlike-differential-node-before-audit-fixes.json)では、各環境で不一致190件、未対応156件だった。この件数は同じ入力を複数経路で実行した数であり、バグ数ではない。今回の通過範囲も、SQLite全機能・全入力の互換性証明ではない。[全機能監査](sqlite-feature-audit.md)は未対応API・SQL・未検証項目が残り、引き続きexit 1になる。

## 修正内容

| ID | 修正した問題 | 実装と検査 |
| --- | --- | --- |
| B01 | TEXTのhex・binary・octal・桁区切りを誤って数値化し、STRICTも通す | [数値変換](../../packages/sqlike/src/full/value.mbt)をSQLのdecimal字句に限定。算術のprefix変換と、affinityの全文変換を分離。NULを含むTEXTのINTEGER/REAL分類も照合 |
| B02 | NOCASE＋NULの比較とPK正規化が異なり、重複キーを保存する | 共有NULまでのASCII比較と元のUTF-8長を使い、[PKキー](../../packages/sqlike/src/full/primary_index.mbt)にも同じ同値関係を適用。書出したSQLiteの`integrity_check`はBINARY/NOCASEとも`ok` |
| B03 | STRICT ANYのUSINGで異なる格納クラスを誤って結合 | ANYを、式の無affinityと区別できるBLOB affinityとして扱う。INNER/LEFT/RIGHT/FULLを差分検査 |
| B04 | USINGで左列のBINARYより右列のNOCASEを優先する | [比較式](../../packages/sqlike/src/full/evaluate.mbt)の列collation優先度を、数値affinityの有無から分離 |
| B05 | 単項`+`で列のNOCASE/RTRIMが失われる | 単項`+`のaffinity除去とcollation継承を分離。CASTの列collation継承も検査 |
| B06 | 負のrowidだけの表で自動採番を0へ進められない | 非AUTOINCREMENT表では実際の最大rowidを基準にする |
| B07 | REPLACEのNOT NULL列でDEFAULTを使わず拒否する | [INSERT](../../packages/sqlike/src/full/execute.mbt)でDEFAULT適用後にNOT NULLを検査。DEFAULTなしのNULLは拒否 |
| B08 | 文の途中失敗で接続の最終挿入IDまで戻す | データのrollbackと接続カウンターを分離。[Statement](../../packages/sqlike/src/full/interface.mbt)、動的SQL、永続化アダプター、注入ランタイムのhost transactionも回帰検査 |
| B09 | SUMの非数値TEXTの結果型とoverflowが異なる | [共通の集約状態](../../packages/sqlike/src/full/aggregate_sum.mbt)で整数昇格・遅延overflow・誤差補正を実装。通常集約・window・高速経路で共有 |
| B10 | 重複キーJSONを拒否し、最初の値を抽出できない | [SQL専用JSON木](../../packages/sqlike/src/full/json_functions.mbt)で順序・重複を保持。最初のキーの抽出・編集・削除、ネスト・patchを検査。保存用JSONとは分離 |
| B11 | 非宣言の隠しrowidをUSINGで結合する | 宣言された可視列に限定し、prepare時に拒否 |
| B12 | 子表先行のDDLや親表INSERTを過剰に拒否する | DDLとDMLのFK検査時点を分離。空の子表を全件検査で誤判定せず、子表へのDML準備時には親キー定義を検証 |

数値変換・照合順序は[本家の型規則](https://www.sqlite.org/datatype3.html)、REPLACEは[競合処理](https://www.sqlite.org/lang_conflict.html)、接続カウンターは[last_insert_rowid](https://www.sqlite.org/c3ref/last_insert_rowid.html)を参照する。SUMの誤差補正・overflow判定は[SQLiteのSumCtx実装](https://github.com/sqlite/sqlite/blob/master/src/func.c)に沿って実装した。

追加の回帰検査で、SQLのROLLBACK / ROLLBACK TO後に主キーキャッシュが残る問題も修正した。行・schemaの復元時に派生キャッシュを無効化する。hostがcloneを復元する場合は`database_copy_connection_state` / `aot_copy_connection_state`で接続カウンターだけを引き継ぎ、失敗した変更を永続化しない。

## 追加した互換動作

- `<<` / `>>`：符号付き64bit、負のshift数、64以上、NULLを検査。
- `round` / `quote` / `unicode`：arity、NULL、文字列NUL、BLOB、実数の境界を検査。
- 列制約の`INTEGER PRIMARY KEY DESC`はrowid別名にしない。表制約の`PRIMARY KEY(id DESC)`はSQLiteのrowid別名規則を保つ。
- 隠し`rowid` / `_rowid_` / `oid`へのINSERT、NULLによる採番、重複時のABORT / IGNORE / REPLACE。宣言列が同名なら宣言列を使う。
- `1e999`のInfinity、演算によるNaN→NULL、論理画像とSQLiteファイルのInfinity往復。SQL結果の`ResultCell`は明示したInfinity文字列を使い、JSON nullへ壊さない。Worker結果にも対応する。SQL同期の入力`Cell`・bindingの有限値制限は変更していない。
- JSON重複キーと深さ1,000 / 1,001の受理・拒否境界。

既存の有限値の画像形式とnotesの事前生成プログラムは維持する。FTSと実験的LSMは引き続き通常バンドルに含めない。

## 速度改善

[全量レポート](../../measurements/p0-before/sqlite-speed-current.json)を100 / 1,000 / 5,000行と、100行＋無関係な5,000行で再採取した。[比較用レポート](../../measurements/sqlite-speed-differential-audit.json)は、その同じ採取から1,000行と無関係な表がある条件を抽出し、元ファイルとhashを記録する。

Chromium内のmemory DB、7サンプル中央値、単位µs/操作。SQLikeはAOT、SQLite WASMはprepared再利用。ABIのJSON decode・型取得を含み、IndexedDB・OPFS・通信を含まない。

| 条件・処理 | SQLike JS 修正前→修正後 | SQLike Wasm 修正前→修正後 | SQLite 修正後 |
| --- | ---: | ---: | ---: |
| 1,000行・主キー検索 | 4.64 → 4.83 | 4.87 → 4.76 | 1.39 |
| 1,000行・miss | 3.73 → 3.71 | 4.03 → 4.13 | 0.46 |
| 1,000行・LIMIT 10 | 17.09 → 13.70 | 11.72 → 10.13 | 9.31 |
| 1,000行・SUM＋COUNT | 253.93 → 18.26 | 238.76 → 11.52 | 21.47 |
| 1,000行・UPDATE | 5.89 → 5.46 | 3.59 → 3.80 | 1.27 |
| 100行＋無関係5,000行・UPDATE | 8.59 → 3.78 | 3.91 → 3.28 | 1.19 |

[修正前](../../measurements/sqlite-speed-differential-audit-before-audit-fixes.json)と比較した。単純SUM＋COUNTの速さを、GROUP BY・JOIN・全SQLの速さへ一般化しない。主キー検索・missの固定費は大きく残る。

| 実施した改善 | 条件・残るコスト |
| --- | --- |
| [集約の直接走査](../../packages/sqlike/src/full/aggregate_plan.mbt) | 固定列・定数のCOUNT/SUM/TOTAL/AVGを一度の走査で処理し、列名解決と全行environmentを省く。JOIN・GROUP BY・DISTINCT・window等は通常経路へ戻す |
| rowid順の再利用 | LIMITのたびに全候補をcopy/sortせず、既存の上限付き索引cacheへ保存。挿入・rowid変更・削除を差分反映し、rollbackで無効化 |
| rowid→物理slot | PK索引にslotを保持し、UPDATE後の再探索を省く。DELETEの位置ずれはcacheを破棄して再構築 |
| 行配列のcopy-on-write | checkpoint/cloneはimmutable行配列を共有し、変更する表だけ初回書込み時にcopy。trigger/FK経由の変更も同じ更新関数を通す |

コピーオンライト後も、**書込み対象表の配列コピーはO(N)**で、DELETEも配列を作り直す。無関係な表を複製しない効果は得られたが、1,000行UPDATEのWasmには改善を確認できていない。5,000行UPDATEもSQLiteより遅い。次の候補は変更表内のundo/paged構造とAOTの準備・JSON境界の固定費で、今回の修正へは含めない。保持する索引には追加のメモリが必要で、heap使用量の定量測定は今回行っていない。

CPU profileは集約・LIMIT・更新の4本を時間測定後に別採取した。1msサンプリングの分類は処理比率の目安であり、速度保証ではない。バンドル差は[サイズ計測](runtime-size.md)に記録する。

## 再現

```sh
just differential-audit
LITESTREAM_BIN=/path/to/litestream just check

# 全行数の速度比較と、集約・LIMIT・更新のCPU profile
just sqlite-bench --profile-queries=aggregate,limit,update

# 1,000行に限定して独立採取する場合
just sqlite-bench --rows=1000 --profile-queries=aggregate,limit,update --output=/tmp/sqlite-audit-speed.json

# 別seedの128系列×24操作
pnpm exec tsx scripts/audit-sqlike-differential.ts --seed=0x31415926 --family=mutation-sequence --output=measurements/sqlike-differential-mutations-alt.json

# 未対応・未検証が残る全機能監査はexit 1
just sqlite-audit
```

差分ゲートはコーパス欠落、結果不一致、予期しない準備拒否、staleな成果物、参照実装の差、書出し整合性の異常も検査する。`--report-only`は採取用であり合格判定ではない。

- [元のコーパス](../../tests/compatibility/differential-corpus.ts) / [追加66件](../../tests/compatibility/audit-fix-corpus.ts)
- [比較器テスト](../../tests/differential-runner.test.ts) / [保存・アダプター回帰](../../tests/sqlike-audit-fixes.test.ts)
- [Node結果](../../measurements/sqlike-differential-node.json) / [Chromium結果](../../measurements/sqlike-differential-chromium.json)
- [別seed結果](../../measurements/sqlike-differential-mutations-alt.json) / [厳格なゲート](../../scripts/check-sqlike-differential.ts)
