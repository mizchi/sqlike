# 10万行のSQLite比較

通常の100 / 1,000 / 5,000行と、10万行の経路を分ける。日常の`sqlite-bench` / `sql-prepare-bench` / P0は従来のデータセットを維持する。

```sh
just sqlite-large-bench
# 任意の行数。100〜100,000の100の倍数を指定できる
just sqlite-bench --prepared --rows=100000 --profiles=false
# 1サンプルの動作確認。通常の計測レポートを上書きしない
just sqlite-bench --smoke --prepared --rows=100000
```

専用タスクはSQLike JS / Wasm GCのAOT・uncached SQL・cached SQLと、SQLite WASMのprepared / prepare毎回の計8経路を同じChromiumページで比較する。全8 workloadと、実変更＋範囲読取の局所変更・索引両端移動を残す。native SQLiteを参照し、実行前後の型付き行・更新結果を照合する。全件読取では10万行全てを照合し、集約でも行数と合計を確認する。

## 実行時間の制御

| 設定 | 通常（10,000行以下） | 大規模（10,000行超） |
| --- | --- | --- |
| サンプル数 | 7 | 3 |
| 1サンプルの目標 | 50 ms | 20 ms |
| 校正 | 2回 | 2回 |
| 最低反復回数 | 5 | 1 |
| 返却行数の反復予算 | なし | 200,000行 / sample |
| warmup | 最大200回 | 最大2回 |
| JSON decode診断 | 最低50回、warmup 100回 | 最大200,000行、warmup 1回 |
| データセットのwatchdog | 180秒 | 120秒 |

行数予算は`expectedRows × iterations`で反復数を制限する。例えば10万行のscanは校正時点で最大2回、1回が20 msを超えればsampleは1回まで下がる。1回のクエリやGCを20 msで中断するものではなく、実際の時間と反復回数を記録する。少ないサンプルの結果なので、小さい差を最適化の効果と判定しない。

10万行だけの指定では、100行＋無関係5,000行の診断を追加しない。CPU profileは既存の1,000行 / 無関係表の診断でのみ採取する。`sqlite-large-bench`はprofileを無効にする。cacheの保持heap診断は計測後にGCして別に記録する。

## 初期データの準備

大規模経路ではnative SQLiteの初期状態を`DatabaseSync.serialize()`で一度取り出し、SQLikeの公開SQLite importで読み込む。その論理画像を各SQL / AOT接続へ公開restore API経由で復元する。AOTはprogram / schema identityの検査を通し、各接続は独立した状態を持つ。SQLite WASMは同じSQL batchで初期化する。

この初期化は計時外であり、INSERTの性能・画像復元の比較・アプリ全体の起動時間は測らない。schema・行データを揃え、対象クエリの結果をnative SQLiteと照合する。画像復元とINSERTでは初期の接続カウンターが異なるため、初期カウンターの同値性はこのbenchmarkの主張に含めない。UPDATEの主表は最初の変更後の同値反復で、実変更は索引の2 workloadに分ける。

レポートには初期SQLite画像のbytes / SHA-256、source / artifact hash、sampling設定、`setupMilliseconds` / `measurementMilliseconds` / `totalMilliseconds`、スクリプトの経過時間を残す。スクリプトの経過時間にはMoonBitのbuild・pnpm起動を含めない。watchdogはbrowser pageを閉じて異常終了する。同期的なnative oracle処理を途中で中断する機構ではない。

## 計測結果

[![10万行・8経路の速度比較。処理ごとに尺度を分け、中央値と3サンプルの最小〜最大を表示。](../images/sqlite-large-benchmark.svg)](../images/sqlite-large-benchmark.png)

短い棒ほど高速。各パネルの軸はゼロから始まり、処理ごとに尺度が異なる。集約と全件取得はms、ほかはµs。ひげは観測した最小〜最大で、信頼区間ではない。画像をクリックするとPNG版を開ける。

<!-- sqlite-large-results:start -->
2026-11-17、Apple M5 / Chromium 158.0.8127.18、10万行、3サンプルの中央値。単位µs。

| workload | JS AOT | JS uncached | JS cached | Wasm AOT | Wasm uncached | Wasm cached | SQLite prepared | SQLite uncached |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 定数式 | 3.42 | 16.63 | 2.81 | 1.84 | 3.46 | 1.30 | 1.72 | 3.76 |
| 主キーhit | 1.80 | 23.49 | 1.09 | 1.91 | 6.54 | 0.98 | 1.49 | 3.90 |
| 主キーmiss | 1.14 | 19.53 | 0.75 | 1.06 | 5.58 | 0.49 | 0.50 | 2.52 |
| 範囲10行 | 7.68 | 36.60 | 7.37 | 7.02 | 12.84 | 5.43 | 10.39 | 14.67 |
| LIMIT 10 | 4.96 | 35.98 | 4.59 | 4.80 | 9.41 | 3.62 | 9.30 | 12.44 |
| SUM＋COUNT | 1,592.31 | 1,741.67 | 1,691.67 | 968.18 | 950.00 | 945.45 | 2,090.00 | 2,110.00 |
| 全10万行 | 78,900.00 | 86,000.00 | 80,200.00 | 74,100.00 | 73,300.00 | 77,200.00 | 102,600.00 | 102,000.00 |
| 同値UPDATE | 4.56 | 18.43 | 3.96 | 2.61 | 5.32 | 2.26 | 1.38 | 3.35 |

実変更＋範囲読取の1 cycle（µs）:

| workload | JS AOT | JS uncached | JS cached | Wasm AOT | Wasm uncached | Wasm cached | SQLite prepared | SQLite uncached |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 索引値の局所変更 | 11.60 | 68.31 | 10.21 | 9.21 | 17.94 | 7.97 | 12.50 | 19.85 |
| 索引の両端へ移動 | 188.68 | 240.96 | 198.02 | 40.72 | 48.62 | 38.40 | 13.28 | 20.29 |

スクリプト全体 **22.90秒**、準備 **8.54秒**、計測・照合 **13.46秒**。残りは起動・cache保持heap診断などを含む。8 workload × 8経路の64組を照合した。全件scanの反復は各sample **1回**、decode診断は **2回**・warmup **1回**だった。
<!-- sqlite-large-results:end -->

今回の条件では、索引両端移動＋範囲読取がcached SQLでもJS 198.02 / Wasm 38.40 µs、SQLite preparedは13.28 µsとなった。大きい表での索引移動を次の最適化候補として記録する。

[raw report](../../measurements/dynamic-prepare-large-current.json)。SQLikeは事前encode済みbindと返り値のJSON.parse、SQLite WASMは型の取得・BigInt化を含む。ABI費用は同一ではない。永続化・ネットワーク・Drizzleを含まないmemory DBの条件であり、通常の[5,000行の比較](dynamic-sql-prepare.md)とは準備方法とサンプル予算が異なる。

出力先の既定は、大規模を含むprepared比較が`measurements/dynamic-prepare-large-current.json`、uncached / AOTの6経路比較が`measurements/sqlite-large-current.json`。小さいデータセットの現行レポートを上書きしない。`--output=...`で変更できる。

スケジューリングは[policy](../../scripts/sqlite-bench-policy.ts)へ分離し、[テスト](../../tests/sqlite-bench-policy.test.ts)で行数の境界・独立した出力先・scan / decodeの反復上限を検査する。runtimeの実装・配信bundleは変更しない。
