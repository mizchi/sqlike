# IN SELECTの再利用と保持予算

2026-11-18、未リリース。`inSelect`は意味上のquery part、`inSelectLookup`は個別に無効化できるoptimizer。literal / bind INの`inListLookup`とは分ける。固定catalogから推論し、不要なAOT / binaryのJS / Wasmから実装を除去する。

## 初期範囲

- 単一の物理表またはFROMなしの非相関RHS。WHERE・ORDER BY・LIMIT / OFFSET・基本演算・純粋関数を使える。scalar / 行値の双方で、最初に必要となった時点で一度だけ実体化して検索構造を作る。
- 空集合、NULL候補、int64 / REAL境界、列affinity、BINARY / NOCASE / RTRIMを従来と同じ比較規則で扱う。行値のNULL候補はhashだけで判定せず残余比較する。
- 外側のsourceにはJOIN・view・CTE等を使える。INリストのliteral / bind cacheも一般sourceへ広げ、FULL JOINの統合列が持つ比較規則を保つ。
- 列だけを左辺にするIN SELECT条件とCOUNT / SUM / AVG / TOTALでは、`aggregateScan`と併用して物理slotを読む。全入力のEnvironmentとgroup配列を作らない。
- UPDATE / DELETEのWHERE・SET・RETURNINGではliteral / bind INを文単位で再利用する。UPDATE FROMのsource条件・SETと、対象行のRETURNINGも別scopeで準備する。

相関RHS、複数source・集約・compound・CTEを含むRHS、nested query・volatile関数、DML中のIN SELECTは汎用経路。書き換え途中の表をRHSが参照する場合に、文頭の値へ勝手に固定しない。[SQLiteの式の仕様](https://sqlite.org/lang_expr.html#subq)を参照し、非相関であることをRHSだけのscopeで検査する。

Program / StatementはAST・列位置・比較metadataだけを保持する。cache frameには実行ごとのbindと現在のStoreを使い、次回execute・restoreへ検索値を持ち越さない。空表・未選択CASEは検索構造を作らず、budget不足でも左辺を二度評価しない。

## 保持量の契約

同じSELECT / DML評価scopeのINリストとIN SELECTで、**4,096 entry / 推定256 KiB**を共有する。保持前に値型・TEXT / BLOBのpayload・行幅を見積もり、超える場合はそのframeを無効にして逐次比較する。cache自体を永続snapshotへ出さない。

これはJavaScript / Wasmの実heap量の厳密な上限ではない。概算にはキー・payloadの余裕を持たせるが、allocatorやMapの実装依存分までは計測していない。RHSを一度実体化する一時配列、一般SELECTの行environment、DB全体、nested SELECTの別scopeはこの予算の外にある。大きい右辺で保持を断った場合、繰り返し走査の時間は増える。

ベンチマークはGC後baselineとの差と各呼出後のheap観測を記録する。Wasm GCを含む完全な使用量、実行中peak、RSSの上限・削減保証としては使わない。browserの永続化・RPC・IDB費用は計時に含めない。

## 検証

[非相関・相関・一般source・大payload](../../tests/sqlike-in-select.test.ts)、[DMLとrollback](../../tests/sqlike-dml-in.test.ts)、[AOT / binary、JS / Wasm、再bind・restore・除去](../../tests/sqlike-in-select-profile.test.ts)、[内部の予算境界](../../packages/sqlike/src/full/in_select_wbtest.mbt)を検査する。共有差分corpusはoptimizerを無効にしたfullも比較する。

計測は`just bench-in-select`。RHSが64行の5千行と8行の10万行を使い、遅い対照の実行時間を抑える。同じソース・catalog・4 exports・他のoptimizer設定で`inSelectLookup`だけを切り替える。準備・seed・bindのJSON化を除き、結果のJSON読込を含める。warmup後の3サンプルの中央値を記録する。

単位はms / COUNT、中央値。Apple M5、Node v24.22.2、SQLite 3.53.4。

| 対象 | 行数 | RHS行数 | JS再実行 | JS cache | Wasm再実行 | Wasm cache | SQLite prepared |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| scalar | 5,000 | 64 | 211.435 | 1.406 | 202.307 | 0.903 | 0.123 |
| scalar | 100,000 | 8 | 864.863 | 7.161 | 736.939 | 3.844 | 1.540 |
| 行値 | 5,000 | 64 | 257.074 | 9.834 | 216.487 | 4.051 | 0.179 |
| 行値 | 100,000 | 8 | 1152.346 | 126.008 | 919.343 | 57.816 | 2.485 |

[SQL・全サンプル・heap観測・source / 成果物hash](../../measurements/in-select-paired.json)。

同じ速度計測artifactのengine単体容量。単位KiB、JSはOXC minify、Brotli quality 11。host・catalog・loaderは除外する。

| 対象 / target | cacheなし | cacheあり | なしBrotli | ありBrotli |
| --- | ---: | ---: | ---: | ---: |
| scalar / js | 416.72 | 431.59 | 78.93 | 81.10 |
| scalar / wasm | 376.61 | 389.07 | 118.05 | 121.80 |
| row / js | 427.61 | 443.71 | 80.75 | 83.10 |
| row / wasm | 387.13 | 401.48 | 121.50 | 125.48 |

## 残る改善

一般RHSとDMLの安全な再利用、NULL候補の残余走査、行値キーの生成、一般sourceの列slot化、cacheを含む実allocation / peak計測を残す。相関のある式を非相関として扱う高速化や、設定予算から全体heapの上限を推定する方法は採らない。
