# SQLike の JS / Wasm GC 実行速度

2026-11-14、Apple M5 / macOS arm64、Moon 0.1.20261104 の release build を比較した。Wasm は `wasm-gc` target と JS string builtins を使う。ブラウザは Chromium 158.0.8127.18、Node は v24.22.2。

以下は SQLike の最適化前の記録。[その後の改善計画と測定値](sqlike-optimization-plan.md)も参照する。

この条件では、Wasm GC は動的 SQL の定数式と LTX 処理で速い。パーサを除いた AOT の検索・更新まで一律に速くなるわけではなく、Chromium では JS がやや速かった。ブラウザの既定バックエンドは変更していない。

[ビルドサイズの比較](runtime-size.md#js--wasm-gc-のビルド差)では、Wasm は未圧縮で小さいが、Brotli 後は JS より16〜27%大きい。以下の実行速度だけから配信量の削減は判断しない。

```sh
just wasm-bench
just wasm-bench --output=measurements/wasm-speed-local.json
```

[計測器](../../scripts/bench-wasm.ts)は、[共通 workload](../../scripts/wasm-bench-workload.ts)を Node と Chromium の両方で実行する。[測定値・全サンプル・成果物 hash](../../measurements/wasm-speed-current.json)を保存している。

## Chromium

1操作あたりの中央値。SQL は μs、データは100行。動的 SQL は毎回 SQL を parse し、AOT は事前コンパイル済みの query 名を呼ぶ。倍率は `JS / Wasm` で、1を超えるほど Wasm が速い。

| SQL / 経路 | JS μs | Wasm GC μs | 倍率 |
| --- | ---: | ---: | ---: |
| 定数式 / AOT | 3.96 | 2.53 | 1.57x |
| 定数式 / 動的 SQL | 18.34 | 3.41 | 5.38x |
| 1行検索 / AOT | 93.65 | 101.45 | 0.92x |
| 1行検索 / 動的 SQL | 129.90 | 99.05 | 1.31x |
| 100行取得 / AOT | 426.40 | 435.80 | 0.98x |
| 100行取得 / 動的 SQL | 468.20 | 424.20 | 1.10x |
| UPDATE / AOT | 83.40 | 87.80 | 0.95x |
| UPDATE / 動的 SQL | 103.60 | 86.20 | 1.20x |

SQLite / LTX は **ms/操作**。SQLite 書き出しは100行の8,192 B、LTX は270,336 Bの SQLite イメージから137,121 Bのフルスナップショットを生成し、空の DB へ適用する。

| 処理 | JS ms | Wasm GC ms | 倍率 |
| --- | ---: | ---: | ---: |
| SQLite 書き出し | 0.300 | 0.310 | 0.97x |
| LTX 生成 | 12.20 | 6.89 | 1.77x |
| LTX 適用 | 12.37 | 9.17 | 1.35x |

初回と再計測のブラウザ結果でも、AOT の検索・更新は JS が速く、LTX は Wasm が速かった。小さい SQLite 書き出しは初回が0.350 / 0.260 ms、再計測が0.300 / 0.310 msと順位が変わるため、高速化の根拠にしない。

## Node 24

同じ workload の中央値。Node と Chromium は V8 のバージョンも実行環境も異なるため、相互の絶対値の差を JS / Wasm の差とは扱わない。

| SQL / 経路 | JS μs | Wasm GC μs | 倍率 |
| --- | ---: | ---: | ---: |
| 定数式 / AOT | 4.26 | 2.75 | 1.55x |
| 定数式 / 動的 SQL | 11.53 | 5.20 | 2.22x |
| 1行検索 / AOT | 127.95 | 103.04 | 1.24x |
| 1行検索 / 動的 SQL | 136.53 | 102.59 | 1.33x |
| 100行取得 / AOT | 669.73 | 541.20 | 1.24x |
| 100行取得 / 動的 SQL | 642.28 | 537.22 | 1.20x |
| UPDATE / AOT | 133.60 | 120.29 | 1.11x |
| UPDATE / 動的 SQL | 153.34 | 114.07 | 1.34x |

| 処理 | JS ms | Wasm GC ms | 倍率 |
| --- | ---: | ---: | ---: |
| SQLite 書き出し | 0.388 | 0.267 | 1.45x |
| LTX 生成 | 17.56 | 7.43 | 2.36x |
| LTX 適用 | 17.73 | 9.38 | 1.89x |

初回の Node 測定では1行検索のサンプルに最大約7.5倍の幅があり、再計測した。原因は特定していない。[初回の記録](../../measurements/wasm-speed-initial.json)も残している。再計測でも定数式・更新・小さい書き出しにはばらつきがあり、正確な速度比の保証にはしない。

## 比較条件と検証

- JS / Wasm の両方で入力 bindings を事前に JSON 化し、公開文字列 API を呼び、戻り値の JSON を decode する。値を JS の bigint などへ戻す facade は含まない。既存の `just sqlike-bench` とは API 境界が異なる。
- 定数式10,000回、1行検索2,000回、100行取得・更新各500回を1サンプルとする。各経路1,000回 warm-up 後、実行順を入れ替えて7サンプルを測る。UPDATE は同じ行へ同じ値を書き、前後に別の SELECT で結果を確認する。
- 書き出し・LTX は各3回 warm-up 後、10操作×7サンプル。SQLite 書き出しには更新前のスナップショットを使い、更新回数によるヘッダー変更を避ける。
- LTX の生成・適用は両実装とも base64 の入出力を含む。JS の byte 配列 API だけを使った時間、実際の worker 全体、差分 LTX の速度は今回の比較に含まない。
- SQL の期待値は native `node:sqlite` 3.53.4 から取得する。書き出した SQLite は native の `integrity_check` と全行取得で確認する。LTX は MoonBit decoder の通常の byte API でも検証し、JS / Wasm の同一バイト列と適用後の元イメージ一致を要求する。この往復だけでは独立した実装との互換性確認にはならないため、本家 Go decoder / Litestream との互換性は既存の [LTX writer テスト](../../tests/ltx-writer.test.ts)で別に検査する。
- Node 1 process と Chromium 1 page を順番に測る。保存・IndexedDB・RPC・ネットワーク・Wasm コンパイル・モジュール起動は計時区間の外。GC は強制せず、各サンプルと最小・最大も保存する。全 SQL の互換性や、アプリ全体の高速化を保証する測定ではない。

計測器の結果不一致・書き込み検証・SQLite / LTX 往復を検査する [テスト](../../tests/wasm-bench.test.ts)と、既存の Wasm 差分テストを通している。配信量・起動・永続化を含む指標は [AOT 計測](aot-performance.md)を参照する。
