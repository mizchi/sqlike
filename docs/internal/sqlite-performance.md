# SQLite WASM と SQLike の速度差・最適化候補

現行の再計測は[R02](aot-ltx-upload.md)、行ストアの変更は[P02](row-store.md)、以前の列差分は[S01](column-delta.md)、AOT改善は[P01](p01-aot-results.md)を参照。以下は以前の実装・計測の記録である。

2026-11-14、Apple M5 / macOS arm64 / Chromium 158.0.8127.18 / Moon 0.1.20261104 の release build を計測した。比較相手は公式 SQLite WASM 3.54.1。期待値の生成は Node 24.22.2 の native SQLite 3.53.4 を使う。

以下は最適化前の比較。主キー検索・更新の差が大きく、SQLike の全行走査と、行ごとの名前解決を優先して減らした。[改善計画と実施結果](sqlike-optimization-plan.md)に、その後の実装と最新の測定値を記録する。定数式では SQLike Wasm GC の AOT と SQLite prepared が約2 μsで近く、Wasm backend 自体が一律に遅いという結果ではない。

## 1,000行での比較

μs/操作、7サンプルの中央値。SQLike は AOT、SQLite は prepared statement を再利用。検索対象は4列のテーブルで、取得列は `id,n,title`。保存・通信・起動時間は含まない。

| 処理 | SQLike JS | SQLike Wasm GC | SQLite WASM | JS / SQLite |
| --- | ---: | ---: | ---: | ---: |
| 定数式 | 3.90 | 2.07 | 2.01 | 1.9x |
| 主キーで1行検索 | 948.21 | 988.46 | 1.57 | 605.6x |
| 存在しない主キー | 942.11 | 1,003.85 | 0.505 | 1,866.9x |
| 索引列の範囲検索・10行 | 1,364.86 | 1,590.32 | 11.21 | 121.8x |
| `ORDER BY id LIMIT 10` | 3,585.71 | 4,383.33 | 10.87 | 330.0x |
| `sum(n),count(*)` | 645.68 | 566.32 | 26.68 | 24.2x |
| 全1,000行取得 | 4,840.00 | 5,330.00 | 1,063.83 | 4.5x |
| 主キーで1行更新 | 992.86 | 1,016.00 | 1.52 | 651.7x |

表の倍率は丸める前の測定値から算出した。同じデータで SQL を毎回コンパイルする経路も測っている。主キー検索は SQLike JS 977.08 μs / Wasm GC 982.69 μs / SQLite 3.92 μsで、prepared の有無だけでは差を説明できない。

## 行数を増やした場合

主キー検索の中央値。SQLike は行数にほぼ比例し、SQLite はこの範囲ではほぼ一定だった。

| 行数 | SQLike JS AOT μs | SQLike Wasm AOT μs | SQLite prepared μs |
| --- | ---: | ---: | ---: |
| 100 | 106.57 | 110.54 | 1.61 |
| 1,000 | 948.21 | 988.46 | 1.57 |
| 5,000 | 5,175.00 | 5,000.00 | 1.60 |

存在しない主キーでも SQLike は5,000行で約5 msを使う。結果が空でも遅いため、結果 JSON のサイズだけの問題ではない。`LIMIT 10` は100 / 1,000 / 5,000行で JS が0.357 / 3.586 / 18.820 ms、SQLite が0.0106 / 0.0109 / 0.0098 msだった。

SQLite の実際の `EXPLAIN QUERY PLAN` は主キー検索に `SEARCH t USING INTEGER PRIMARY KEY (rowid=?)`、範囲検索に `SEARCH t USING INDEX ix_t_n (n>? AND n<?)` を示した。SQLike にも同じ INDEX を作っているが、現在の SELECT はその情報を探索に使っていない。EXPLAIN は診断用の出力として記録し、アプリの動作判定には使っていない。[SQLite の公式説明](https://sqlite.org/eqp.html)

## CPU プロファイル

SQLike JS AOT を別に1秒ずつ実行し、Chromium CDP Profiler で1 ms間隔のサンプルを採った。以下はサンプル時間に対する割合。関数名と呼び出し元をたどって最も内側の分類へ一度だけ割り当てている。JIT のインライン化や native 関数で帰属が変わるため、厳密な処理フェーズの内訳ではない。

| 処理 | 列名解決・正規化 | 行の評価用データ | 退避コピー | JSON と認識できた部分 | GC |
| --- | ---: | ---: | ---: | ---: | ---: |
| 主キー検索・1,000行 | 53.6% | 20.0% | — | 0.1% | 3.7% |
| LIMIT 10・1,000行 | 72.8% | 5.7% | — | 0.6% | 4.7% |
| 全1,000行取得 | 54.4% | 4.4% | — | 10.4% | 5.1% |
| 1行更新・1,000行 | 59.5% | 20.8% | 1.2% | 3.5% | 2.0% |
| 1行更新・100行＋無関係な5,000行 | 37.6% | 13.6% | 30.6% | 0.7% | 3.4% |

ソート・比較に分類されたサンプルは各0.1〜2.1%。ソート単体の入れ替えよりも、全行を処理する回数と名前解決を減らす方を優先する。

ホスト側の `JSON.parse` だけを、同じ結果文字列で別計測した。全1,000行の81,474文字では約224 μsで、JS AOT の全体4,840 μsの約4.6%。MoonBit 側の JSON 生成、型変換、割り当てはこの値に含まない。JSON 境界にも改善余地はあるが、主キー検索の数百倍の差を最初に解消する対象ではない。

## 実装する優先順位

1. **主キーと二次索引で候補行を絞る実行計画を作る。** [source_rows](../../packages/sqlike/src/full/query.mbt#L42) はテーブル全行をコピー・ソートし、全行の評価環境を作る。[select_relation_in](../../packages/sqlike/src/full/query.mbt#L159) がその後で WHERE を評価するため、主キーでも全行処理になる。まず単一テーブルの `INTEGER PRIMARY KEY = ?` を探索で実行し、続いて二次索引の等価・範囲検索へ広げる。SQLite の affinity、NULL、rowid と主キーの違いを native 差分テストで固定し、扱えない式は既存経路へ戻す。
2. **AOT で列参照と列メタデータを解決しておく。** [find_binding](../../packages/sqlike/src/full/evaluate.mbt#L49) は列参照のたびに配列を filter し、[identifier](../../packages/sqlike/src/full/model.mbt#L200) を繰り返す。[row_environment](../../packages/sqlike/src/full/evaluate.mbt#L584) も affinity、主キー、隠し rowid 列を毎行再計算する。事前ビルドで列の位置・スコープ・affinity・collation を確定し、行の値と分離する。曖昧な列、alias、相関サブクエリ、空テーブルでの準備エラーを維持する。プロファイルでは最も大きい共通の改善対象だった。
3. **LIMIT と射影を必要な行数までで止める。** 現在は [全行を project](../../packages/sqlike/src/full/query.mbt#L297) してからソートし、[最後に LIMIT](../../packages/sqlike/src/full/query.mbt#L360) を適用する。rowid 順の単純な SELECT なら必要な10行だけ評価・出力する経路を作る。DISTINCT、GROUP BY、window、JOIN、別の ORDER BY には無条件で適用しない。
4. **書き込みの全 DB コピーを、変更箇所の退避へ置き換える。** [Statement::step](../../packages/sqlike/src/full/interface.mbt#L240) と動的 SQL は書き込み前に [copy_store](../../packages/sqlike/src/full/model.mbt#L345) で全テーブルの行をコピーする。100行の表への UPDATE は、無関係な5,000行を足すと JS が97.01 → 134.72 μs、Wasm が94.53 → 126.63 μsになった。対象行・対象テーブルの copy-on-write または undo journal を検討する。文の途中失敗、制約違反、外部キー処理の rollback を削減条件にする。
5. **実行量を減らした後で ABI と JSON を詰める。** [aot_execute](../../packages/sqlike/src/full/aot.mbt#L65) は毎回 bindings を parse し、statement を作り、Cell JSON を返す。prepared handle 再利用、型付きの引数・行の受け渡しを検討する。パーサをランタイムへ戻さず、int64・BLOB・負のゼロを保持する。

これらは計測とコードから絞った候補であり、実装後の速度や容量をまだ保証するものではない。索引を追加した場合は、読み出しだけでなく更新・rollback・restore とバンドルサイズも比較する。

## 再現・検証範囲

```sh
just sqlite-bench
just sqlite-bench --rows=100,1000 --profiles=false
just sqlite-bench --smoke
```

既定は100 / 1,000 / 5,000行の8 workload と、100行の表＋無関係な5,000行の検索・更新。計26 workload ×6経路について、計時前後に native SQLite の型付き・列位置付き期待値を照合する。更新後は別の SELECT で検証する。`--smoke` は短い動作検証であり、速度の評価には使わない。

すべて window の `:memory:` DB。SQLike JS / Wasm GC の AOT・動的 SQL、SQLite WASM の prepared 再利用・毎回 prepare/finalize を同じページで比較する。SQLike bindings は事前に JSON 化し、SQLite bindings は事前に JS 値へ戻す。戻り値は共通の Cell 配列だが、SQLike の JSON decode と SQLite の列型取得・BigInt 変換という異なる境界費用を含む。SQLite の prepared の使用方法は [公式 OO1 API](https://sqlite.org/wasm/doc/trunk/api-oo1.md)に従う。

warm-up 後、各エンジンで約50 msになるよう2回校正し、順番を入れ替えて7サンプルを取る。実際のサンプル時間は約37〜149 ms。元の実行回数と全測定値を保存する。更新は最初の検証時に値を変え、その後は同じ値を書き続ける。保存・OPFS・IndexedDB・RPC・Wasm コンパイル・初期化は計時の外。GC は強制しない。

- [計測器](../../scripts/bench-sqlite.ts) / [ブラウザ共通 workload](../../scripts/sqlite-bench-workload.ts)
- [全サンプル・実行計画・CPU 分類・成果物 hash](../../measurements/sqlite-speed-before-optimization.json)
- 最適化前の主キー検索・LIMIT・全行取得は上記 JSON の重み付き CPU 集計を参照する。対応する生ファイルの一部は再計測で上書きされた。
- [無関係な行がある更新の CPU profile](../../measurements/profiles/before-optimization/sqlite-100-cold5000-update-js-aot.cpuprofile)

CPU 集計にはサンプル数ではなく `timeDeltas` を使い、inclusive time と分類の二重加算を区別する [テスト](../../tests/profile-summary.test.ts)を追加した。今回の workload 一致は、SQLite 全機能互換の達成を意味しない。


主キーmap導入後の最新結果・全機能構成の固定費は[機能選択と主キー索引の追記](sqlike-optimization-plan.md)と[機能選択の契約](sqlike-feature-profiles.md)を参照。SQLiteとの同時測定・相対比較を継続する。
