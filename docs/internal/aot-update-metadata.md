# AOT UPDATEのメタデータ再利用

2026-11-17、0.1.1以降の変更。[Issue #1](https://github.com/mizchi/sqlike/issues/1)の最初の改善項目。

このページは最初のmetadata共有を入れた時点の記録。続く[準備済み実行計画](prepared-execution-plan.md)で、基本式と主キーアクセスも実行用IRへ分離した。以下の比較記録は`bound-plan-before`に保存した。

固定schemaのUPDATEについて、列名の検証・行bindingのlayout・代入先の列番号とaffinity・INTEGER PRIMARY KEYの位置をProgram読込時に解決する。`PreparedUpdatePlan`はProgram内で共有し、同じ表を更新するquery間ではlayoutも共有する。レイアウトの保持量はquery数×表の幅ではなく、更新対象の表の幅の合計になる。代入のmetadataはqueryごとに保持する。

保持するlayoutはNULL値とダミーrowidだけを持つ。Store / Table・行・bind・時計・接続counterは保持しない。各実行では現在のStoreを取得し、候補行から作った評価contextをpredicateとSETの評価で共有する。式の評価器、RETURNINGのprojection、制約・FK・triggerとロールバックは既存の処理を使う。同じ値へのUPDATEも実行し、changesやtriggerを省略しない。動的SQLとtrigger内部の一般経路では引き続き実行時に検証する。

JSON AOTとバイナリdefinedは同じ準備処理を使う。メタデータをwire形式・保存画像には追加せず、0.1.1のランタイムも同じProgramを読める。公開APIの変更はない。catalogでUPDATEを使わないビルドでは、準備関数と適用関数の除去を関数宣言の不在で検査する。

## 比較方法

[`just aot-update-bench`](../../scripts/bench-aot-update.ts)を追加した。Apple M5 / Chromium、100・1,000・5,000行のメモリDB。変更前の0.1.1と変更後のJSON / バイナリ×JS / Wasmを同じページに読み、engine・処理順を回転させて7回測る。bindは事前エンコードし、応答のJSON.parseを含む。初期化・ロード・保存・RPCは計時しない。

同値UPDATE、索引列を両端へ移す実変更、非索引列の実変更、式＋RETURNING、主キーmiss、CHECK失敗を別々の行で測る。初期の主キー・二次索引readは計時外だが、混在workload内の失敗によって派生cacheが置換される場合がある。二次索引の移動だけの費用を分離した計測ではない。計時前後に全行の型付き結果をnative SQLiteと照合し、失敗による副作用も検査する。

変更前のランタイムは作業開始時に保存したrelease build。JSON AOTのJS / WasmのSHA-256が[0.1.1の測定記録](../../measurements/aot-update-before/sqlite-speed-current.json)の成果物と一致することも照合した。全サンプル・成果物hash・ソースhashは[比較記録](../../measurements/bound-plan-before/aot-update-current.json)に保存する。これは変更前後の比較であり、SQLiteとの速度倍率は[通常のSQLite比較](../../measurements/bound-plan-before/sqlite-speed-current.json)で別に測る。

<!-- update-metadata-results:start -->
5,000行、µs/操作、7サンプル中央値。各セルは変更前 → 変更後。

| 経路 | 非索引列の実変更 | 索引列の実変更 | 式＋RETURNING | 主キーmiss |
| --- | ---: | ---: | ---: | ---: |
| JSON / JS | 4.52 → 3.44 | 4.52 → 3.55 | 9.35 → 6.16 | 2.05 → 1.38 |
| JSON / Wasm | 4.03 → 3.12 | 4.04 → 3.14 | 9.89 → 6.47 | 1.57 → 1.06 |
| binary / JS | 4.62 → 3.54 | 4.42 → 3.58 | 9.49 → 6.50 | 1.99 → 1.35 |
| binary / Wasm | 3.87 → 3.09 | 3.87 → 3.14 | 9.90 → 6.37 | 1.58 → 1.05 |

同じ値へのUPDATEは20〜25%、上記の実変更は19〜24%、式＋RETURNINGは32〜36%、missは32〜34%、CHECK拒否は22〜26%の所要時間削減だった。サンプル間の変動も全記録に残す。新しい処理系やABIだけの効果とはせず、同じ経路の変更前後で比較する。

catalog選択後の新baseline（同じ5,000行、µs/操作）:

| 経路 | 非索引列の実変更 | 式＋RETURNING | 主キーmiss |
| --- | ---: | ---: | ---: |
| selected JSON / JS | 3.22 | 5.97 | 1.39 |
| selected JSON / Wasm | 2.66 | 5.82 | 1.05 |
| selected binary / JS | 3.27 | 5.99 | 1.34 |
| selected binary / Wasm | 2.75 | 5.86 | 1.03 |

JSの配信サイズ。minified未圧縮 / Brotli quality 11、単位B。engine単体でありhost・Worker・定義データは含まない。

| 対象 | minified 前→後 | Brotli 前→後 | Brotli増分 |
| --- | ---: | ---: | ---: |
| AOT + SQLite writer + LTX | 575,316 → 579,314 | 109,245 → 109,736 | +491 |
| SQLike dynamic SQL | 618,120 → 620,753 | 116,165 → 116,444 | +279 |
| selected defined / readonly | 366,280 → 368,429 | 72,280 → 72,317 | +37 |
| selected defined / notes | 393,463 → 397,308 | 77,553 → 78,146 | +593 |

readonlyではUPDATEの準備・適用関数が除去されるが、Program / Queryの内部構造の追加費用と圧縮率の変動は残る。notes Programは20,049 B、SHA-256 `a6af7a52769d67773842aae483fcb856b46f628e31180d44afa14d2201bc2de2`で変更前と同じ。追加metadataだけの実heap量は分離計測していない。

通常のSQLite比較では5,000行の同値UPDATEがJS 3.72 / Wasm 2.77 / SQLite prepared 1.33µsで、差は約2.8倍 / 2.1倍残る。別の1秒profileでは1,000行のJS UPDATEのJSON帰属が25.4%、名前解決が16.4%、行環境が8.3%だった。sampling上の分類であり、各割合をそのまま除去可能な時間とは解釈しない。
<!-- update-metadata-results:end -->

catalogから関数・文を選択してOxcでminifyしたJSON / definedのJS / Wasmも同じworkloadで検査・計測する。この4経路は今回追加した速度baselineであり、0.1.1の標準ビルドとの前後比較には混ぜない。

## 互換性と次の対象

[`prepared_update_wbtest.mbt`](../../packages/sqlike/src/full/prepared_update_wbtest.mbt)でplanの再利用・query間のlayout共有・clone / restore後も値を保持しないことを確認する。[native差分](../../tests/aot-update.test.ts)はJSON / バイナリのJS / Wasm各経路で、bind型の切替、REAL affinity、NOCASE、BLOB / NULL、重複代入・列名、隠しrowidとそのshadow、STRICT / WITHOUT ROWID、相関subquery、時計とcounter、同値UPDATEのtrigger、FK cascade、複数行の途中失敗、SAVEPOINT、clone / restoreを検査する。

一般式の列名解決、RETURNINGの評価・JSON marshal、候補索引の解釈は残る。今回は式を列slotへ書き換える独自評価器や新しいABIは導入していない。通常SQLのparse / prepare固定費とJSON割当はIssue #1の後続候補として維持する。

再現時は0.1.1のrelease buildから`runtime.js` / `runtime.wasm`（`examples/aot`）と`defined.js` / `defined.wasm`を一つのディレクトリへ保存し、現在のcheckoutで次を実行する。`--before-dir`を省略すると現在の4経路だけを測る。

```sh
just p0-measure
just aot-update-bench --before-dir=/tmp/sqlike-update-before
LITESTREAM_BIN=/path/to/litestream just p0-check
just bundle-size
```
