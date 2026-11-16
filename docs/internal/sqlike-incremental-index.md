# 二次索引の増分更新

これは単一列 index の増分更新を導入した時点の記録。現在は[複合・降順・部分 index](sqlike-index-trigger.md)の対象行と位置も増分更新する。

2026-11-15、[単一列索引の範囲検索](sqlike-secondary-index.md)に続き、構築済み索引へ INSERT / UPDATE / DELETE の行差分を適用する実装を追加した。書き込み直後の検索のために、索引全体を再ソートする必要をなくす。公開 API・保存画像・事前コンパイル済み artifact の形式は変更しない。この文書は行配列の全体 map を除去する前の第3段階の記録で、現在の結果は[改善計画](sqlike-optimization-plan.md)の第4段階を参照。

## 速度とサイズ

Apple M5 / Chromium 158 / Moon 0.1.20261104 release、前段階と同じ環境・データ・SQL・workload hash。1サンプル約50 msになるよう校正した7サンプルの中央値。SQLike は AOT、SQLite WASM 3.54.1 は prepared statement 再利用。API の呼び出しから型付き Cell 配列を返すまでを含み、SQL VM 単体の比較ではない。

索引列を -7 / -8 と交互に変更し、直後に `WHERE n>=? AND n<? ORDER BY n` で10行を取得する。単位は **更新と検索の1組あたり μs**。最初の索引構築は含まないが、以降の索引維持はすべて含む。

| 行数 | JS 変更前 → 後 | Wasm GC 変更前 → 後 | SQLite WASM・今回 |
| --- | ---: | ---: | ---: |
| 100 | 22.45 → 23.86 | 15.89 → 16.65 | 15.75 |
| 1,000 | 42.75 → **23.61（1.81倍）** | 27.69 → **15.62（1.77倍）** | 13.36 |
| 5,000 | 131.44 → **40.31（3.26倍）** | 78.87 → **22.62（3.49倍）** | 14.52 |

100行では改善していない。別プロセスの計測で、SQLite 側も13.33 → 15.75 μsと変動しているため、小さい差を断定しない。追加の維持コストを含め、すべての規模で速くなるとは主張しない。データ分布は従来どおり `n=i*3` である。

同じ位置の差し替えだけを測らないため、キーを -7 / `(行数*3+7)` と交互に変更して索引の両端間を移動する `indexMovement` も追加した。どちらも取得範囲の外なので、結果10行は同じ native 期待値で検証する。

| 行数 | JS AOT | Wasm GC AOT | SQLite prepared |
| --- | ---: | ---: | ---: |
| 100 | 26.48 | 17.29 | 16.86 |
| 1,000 | 25.09 | 16.58 | 14.23 |
| 5,000 | 47.03 | 22.16 | 14.11 |

この追加測定には変更前の対応サンプルがないため、高速化倍率は出さない。温まった読み取り単独も保持し、1,000行では JS 18.04 μs / Wasm 13.07 μs / SQLite 12.47 μs。主計測は従来と同じ156経路・1,092サンプルで、初回 API 呼び出し、更新と検索、両端移動は別に記録する。

同じ全公開 API を残した AOT ライブラリの Brotli は JS **77.21 → 77.69 KiB（+492 bytes / 0.48 KiB）**、Wasm GC **97.63 → 98.09 KiB（+466 bytes / 0.46 KiB）**。実 AOT アプリの初回転送は **77,619 → 77,892 bytes（75.80 → 76.07 KiB、+273 bytes）**。新しい Chromium プロセスと空の保存領域で各3回測り、オフライン再読込も通過した。Litestream 単体の容量は変わらない。

## 実装と計算量

[index_cache.mbt](../../packages/sqlike/src/index_cache.mbt) は索引列の格納値を既存の `compare_stored` で比較し、同値の場合は rowid で区別する。この比較を初回ソート、変更前の行の探索、変更後の挿入位置の探索で共有する。NULL、数値とテキスト、BLOB、BINARY / NOCASE / RTRIM の順序を変更しない。

更新前の行を二分探索し、変更後も前後の行の間に収まる場合は行参照をその場で差し替える。索引キーが同値でも、索引列以外の最新値を返せるよう参照を更新する。並び順が変わる場合は古い参照を削除し、新しい位置へ挿入する。行の挿入・削除、UPSERT、REPLACE、外部キー cascade も同じ行変更用 helper を通る。

初回は引き続き O(N log N) の構築が必要。構築済み索引内の位置確認は O(log N)、その場の差し替えは O(1) だが、並び順が変わる挿入・削除は配列移動の O(N) が残る。この段階では表の行参照配列の map / filter、文の退避用コピー、主キー候補の線形探索も残っていたため、DB の書き込み全体が O(log N) になったとは扱わない。多数行を変更する場合の計算量や、任意のデータ分布での速度は保証しない。

索引は最大4個で、書き込みだけでは新しく構築しない。無関係な表の索引は変更しない。削除で配列の使用率が1/4未満になったら backing buffer を縮め、削除済み行の参照を解放する。最後の行の削除後は容量も0になる。

スキーマ変更・論理画像の restore・SQLite import は従来どおりキャッシュを破棄する。文の rollback と clone の退避先もキャッシュを共有せず、変更された配列が復元先や別の接続に漏れない。変更前の索引キーを確認できない場合も、その索引を破棄して次回読み取り時に再構築する。

## 互換性の検証

- [MoonBit テスト](../../packages/sqlike/src/index_wbtest.mbt)は「書き込み後も同じ索引配列を保持する」ことを Red → Green で固定した。2本の索引に対する挿入・同値キー・rowid変更・非索引列変更・UPSERT・REPLACE・全行削除・再挿入と、容量縮小、途中で失敗する複数行更新、clone 分離を検証する。
- [native 差分テスト](../../tests/sqlike-index.test.ts)は既存の型付き結果9,472比較に加え、3本の索引を温めた状態で固定 seed の240操作を実行する。混在する格納型・照合順序の重複キー・範囲と LIMIT / OFFSET・複数行更新と削除・NOT NULL / 主キー違反・clone / restore を、JS / Wasm GC の動的 SQL / AOT の4経路で SQLite と照合する。
- `LITESTREAM_BIN=… just check` は MoonBit **26件×JS / Wasm GC**、Node **130件**、Playwright **38件**、型チェックを通過した。本家 Litestream での生成 LTX の復元も含み、従来の論理画像のバイト互換性も検証した。

## 次の改善候補

別採取の JS AOT 更新プロファイルでは、1,000行の `replace_table_row` の self time が約25%、`copy_store` が約13%、主キー候補探索が約8%。100行の表に無関係な5,000行を足した場合は、退避コピーの分類が約56%になった。JIT のインライン化を含むサンプル帰属であり、各処理を除去した場合の高速化率ではない。

この結果から、公開形式や追加の索引状態を変えずに `replace_table_row` の全体 map を特定行の差し替えに置き換える案を優先した。[第4段階の結果](sqlike-optimization-plan.md)に記録する。その後に対象表だけの退避・copy-on-write を検討し、clone・複数行更新・外部キー cascade・失敗時の rollback を採用条件とする。主キー専用索引、複合・降順索引、ABI 変更は引き続き後の候補に置く。

## 再現

```sh
just sqlike-check
LITESTREAM_BIN=/path/to/litestream just check
just sqlite-bench
just build-size
just measure-aot
```

[速度の変更前](../../measurements/sqlite-speed-before-incremental-index.json) / [変更後](../../measurements/sqlite-speed-before-row-replacement.json)、[容量の変更前](../../measurements/wasm-build-size-before-incremental-index.json) / [変更後](../../measurements/wasm-build-size-before-row-replacement.json)、[アプリの変更前](../../measurements/aot-before-incremental-index.json) / [変更後](../../measurements/aot-before-row-replacement.json)を保存する。
