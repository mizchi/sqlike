# 行値metadataとIN検索の再利用

2026-11-18、未リリース。実装の範囲は[行値](row-values.md)、次の着手順は[TODO](../../TODO.md)で管理する。

## 何を減らしたか

prepare時に行値のaffinity / collationを再利用し、実行時には現在のbindと行だけを評価する。16要素以上のliteral / bind IN右辺は最初の利用時に索引化し、次の実行やrestoreへ値を持ち越さない。整数はint64のままキーにし、TEXT・BLOB・REAL・NULLを別の値へ読み替えない。

COUNT / SUM / AVG / TOTALと列だけのIN条件を組み合わせる経路では、物理slotから値を読み、Environmentの全行生成とgroupの保持を省く。行値でも全要素を先に評価し、NULLを含む候補には共通の比較処理を残す。`aggregateScan`と`inListLookup`の両方を有効にした場合の改善で、一般の集約やJOINの高速化とは区別する。

## 同じソースでの有効・無効比較

Apple M5、Node v24.22.2、SQLite 3.53.4。MoonBit release、JSはOXC minify、Wasm GCはJS string builtinsを使う。すべてインメモリ。準備・seed・bindのJSON化は計時せず、結果のJSON読込はSQLikeの計時に含む。2回warmup後に3サンプル、各20ms目標・最大5反復とし、遅い対照は1反復で打ち切る。

WHERE対象は索引のない列で、同じprofile・4 exports・他のoptimizer設定を保ち、`inListLookup`だけを切り替える。5千行と10万行で右辺の幅を変え、線形比較側の実行時間を抑える。行値はINTEGERとNOCASEのTEXT列で、データにNULLを含む。

単位はms / COUNT、中央値。SELECTの結果は各サンプルで本家と照合する。

| 対象 | 行数 | IN幅 | JS無効 | JS有効 | Wasm無効 | Wasm有効 | SQLite prepared |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| scalar | 5,000 | 256 | 109.469 | 0.546 | 97.083 | 0.458 | 0.269 |
| scalar | 100,000 | 16 | 250.128 | 4.772 | 222.357 | 1.667 | 1.839 |
| 行値 | 5,000 | 64 | 88.619 | 5.258 | 55.723 | 2.697 | 0.162 |
| 行値 | 100,000 | 16 | 386.158 | 100.404 | 267.152 | 55.473 | 2.485 |

[SQL・全サンプル・source / 成果物hash](../../measurements/in-list-paired.json)。[整数キー導入前](../../measurements/in-list-before-integer.json)と[slot集約導入前](../../measurements/in-list-before-slot-filter.json)は当時のソースを含むsnapshotであり、現行ソースの同条件比較とは別に残す。

## 行値metadataだけの差

通常の整数列を末尾キーにした索引付きページングで、20行を取得する。単位はµs、中央値。他のoptimizer設定は同じにし、`rowMetadata`だけを切り替えた。

| 行数 | JS無効 | JS有効 | Wasm無効 | Wasm有効 | SQLite prepared |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 136.80 | 104.52 | 63.29 | 39.45 | 2.31 |
| 100,000 | 121.84 | 104.29 | 62.86 | 38.16 | 2.20 |

[SQL・EXPLAIN・全サンプル](../../measurements/row-metadata-paired.json)。rowid aliasを末尾にする別SQLも記録しているが、SQLiteの参照planが異なるため、上の表とは混ぜない。既存のJSON ABIと行評価の費用が残る。

## 配信量の費用

速度計測で使った同じartifactをBrotli quality 11で圧縮した。hostとcatalogは含まない。単位はKiB、増分はbyte数の差から算出する。独立した機能の増分を足し合わせて総サイズを推定しない。

| 構成 | 無効 | 有効 | 増分 | 無効Brotli | 有効Brotli | 増分 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scalar / js | 416.33 | 427.25 | +10.92 | 78.81 | 80.32 | +1.52 |
| scalar / wasm | 376.64 | 387.20 | +10.56 | 118.08 | 121.27 | +3.18 |
| row / js | 430.01 | 447.21 | +17.20 | 81.15 | 83.51 | +2.36 |
| row / wasm | 390.20 | 405.16 | +14.96 | 122.15 | 126.40 | +4.25 |

[サイズの生データ](../../measurements/in-list-size-current.json)。scalarだけのcatalogには行値INの本体を残さない。不要なcatalogや`optimizers: []`ではlookup・slot filterを除去し、[生成JSの関数本体を検査するテスト](../../tests/sqlike-in-list-profile.test.ts)で確認する。

## 次に調べるもの

- [非相関IN SELECT・DMLと一般sourceのcache](in-select-performance.md)を追加した。一般RHSや書込中の可視性を持つ場合の安全な再利用は後続。
- DMLと一般sourceの列slot評価を広げる。UPDATE FROMの単一sourceはslot化済みで、一般結合・SET値の保持を残す。単純なIN集約のslot走査は物理表・列だけの左辺に限定する。
- 行値キーの生成、NULL候補の残余走査、allocation / peakを測る。cacheは4,096 entry / 推定256 KiBの保持予算を追加済み。行値の10万行ではSQLiteとの差が大きい。

```sh
just bench-in-list
just bench-row-metadata
```
