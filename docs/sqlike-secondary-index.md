# 単一列の二次索引による範囲検索

これは単一列 index を導入した時点の記録。現在は[複合・降順・部分 / 式 index](sqlike-index-trigger.md)へ拡張している。

2026-11-15、[改善計画](sqlike-optimization-plan.md)の次段階として、宣言済みの単一列索引を使う実行経路を追加した。索引は行への参照をソートした実行用キャッシュで、保存画像・公開 API・事前コンパイル済み artifact の形式は変更しない。この文書は増分更新を導入する前の第2段階の記録で、現在の実装・測定は[索引の増分更新](sqlike-incremental-index.md)を参照。

## 速度

Apple M5 / Chromium 158 / Moon 0.1.20261104 release。既存と同じデータ・SQL・workload hash で、warm-up 後7サンプルの中央値。`WHERE n>=? AND n<? ORDER BY n` が10行を返す。単位は μs/操作。SQLike は AOT、SQLite WASM 3.54.1 は prepared statement を再利用する。

| 行数 | JS 変更前 → 後 | JS 高速化 | Wasm GC 変更前 → 後 | Wasm 高速化 | SQLite WASM |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 | 106.56 → 16.52 | 6.5x | 124.68 → 12.15 | 10.3x | 11.80 |
| 1,000 | 773.13 → 15.92 | 48.6x | 1,183.72 → 12.24 | 96.7x | 11.28 |
| 5,000 | 3,966.67 → 18.08 | 219.5x | 5,777.78 → 13.93 | 414.8x | 12.64 |

動的 SQL も計測した。1,000行で JS 46.19 μs、Wasm GC 12.83 μs、SQLite の毎回 prepare/finalize は15.76 μs。SQLike の JSON decode と、SQLite の列型取得・BigInt 変換という異なる API 境界を含む。

## 初回と書き込み後のコスト

初回に O(N log N) のソートを行い、再利用中は境界の二分探索と結果行だけを処理する。主な計測は索引が温まった状態なので、初回呼び出しと書き込み・検索の組み合わせも追加した。

`firstRangeRead` は初回 prepare や JIT も含む**単発の API 呼び出し**。1,000行では JS AOT 約1.7 ms、Wasm AOT 約1.4 ms、SQLite prepared 約0.3 msだった。中央値や索引構築単独の時間とは扱わない。

次の表は、索引列の値を毎回変更し、その直後に10行の範囲検索を行う **1組あたりの中央値（μs）**。変更対象は検索範囲外とし、値を -7 / -8 と交互に変える。書き込み・再構築・検索をすべて含む。

| 行数 | JS AOT | Wasm GC AOT | SQLite prepared |
| --- | ---: | ---: | ---: |
| 100 | 22.45 | 15.89 | 13.33 |
| 1,000 | 42.75 | 27.69 | 13.16 |
| 5,000 | 131.44 | 78.87 | 13.29 |

この段階では対象テーブルを変更すると再構築するため、読み取り中心では差が縮まり、毎回書き込む場合は差が残る。データは既存 workload と同じ `n=i*3` の分布で、ランダム分布全般の保証ではない。この測定を受け、[書き込み時の索引の増分更新](sqlike-incremental-index.md)を追加した。

## 対応範囲

- 単一の実表、単純な列・定数・`*` の射影、宣言済み単一列索引、対象列の昇順 ORDER BY。
- `=` / `==` / `<` / `<=` / `>` / `>=` と、同じ列への比較を AND で結んだ条件。境界は literal / parameter。左右を入れ替えた比較も扱う。
- INTEGER / REAL / TEXT / BLOB / NULL を既存評価器と同じ affinity・照合順序で比較する。BINARY / NOCASE / RTRIM を検証した。NULL はソート順に入るが通常の比較条件を満たさないため、範囲検索では除外する。
- LIMIT / OFFSET、ORDER BY の出力 alias、`*` による列展開の優先順位を維持する。LIMIT 0 は名前検証後に返し、索引を構築しない。

複合索引、降順、式索引、明示 COLLATE、OR、別列の追加条件、JOIN、GROUP BY、window、WITHOUT ROWID などの一般化はこの経路の対象外。前提を証明できない場合は既存の実行経路を使う。ORDER BY のない検索を一律に高速化する実装ではない。

## 状態と保存形式

[index_cache.mbt](../packages/sqlike/src/index_cache.mbt) が接続内の実行用索引を保持する。最大4索引とし、行値は複製せず参照を保持する。上限到達時にはキャッシュを捨てて必要に応じて再構築する。ディスクの SQLite B-tree をそのまま実行するものではない。

第2段階では行の追加・置換・削除を共通 helper に集約し、対象テーブルの索引だけを無効化していた。現在は構築済みの索引に行差分を適用する。outbox のような無関係のテーブルへの書き込みでは保持する。スキーマ変更時には全索引を無効化し、schema cookie でも検査する。文の rollback、clone、論理画像の restore、SQLite import ではキャッシュを共有・復元せず、読み直す。

[StoreImage](../packages/sqlike/src/store_image.mbt) は従来の永続データだけを定義し、実行用キャッシュと分離した。変更前に保存した [論理画像](../tests/fixtures/sqlike/pre-index-cache-image.json)は、JS / Wasm の読み込み・キャッシュ利用後も**同じバイト列**で書き出せる。パーサなしの AOT と既存 artifact の互換性も保つ。

[index_plan.mbt](../packages/sqlike/src/index_plan.mbt) が条件全体を認識し、索引区間を二分探索する。条件の一部だけを取り出して、残りの式評価を省くことはしない。型変換と順序の基準は [SQLite の datatype / affinity の説明](https://sqlite.org/datatype3.html)と native 差分テストに置く。

## 検証と容量

[MoonBit の索引テスト](../packages/sqlike/src/index_wbtest.mbt)で構築・境界・無効化・容量上限・画像分離を Red → Green で確認した。[native 差分テスト](../tests/sqlike-index.test.ts)は型付き結果9,472比較に加え、INSERT / UPDATE / DELETE / UPSERT / REPLACE、制約違反後の rollback、外部キー cascade、clone、restore、DROP / CREATE INDEX、ALTER を検証する。

`LITESTREAM_BIN=… just check` は MoonBit **24件×JS / Wasm GC**、Node **129件**、Playwright **38件**、型チェックを通過した。生成 LTX の本家 Litestream での復元も含む。

同じ全公開 API を残したライブラリ単体の Brotli は、AOT JS **75.85 → 77.21 KiB（+1.36）**、Wasm GC **95.65 → 97.63 KiB（+1.98）**。実 AOT アプリの初回転送は **74.30 → 75.80 KiB（+1.50）**。空の保存領域・新しい Chromium プロセスで各3回測り、オフライン再読込も通過した。

```sh
just sqlite-bench
just build-size
just measure-aot
just sqlike-check
```

[速度の変更前](../measurements/sqlite-speed-before-secondary-index.json) / [変更後・初回・書き込み後の全測定](../measurements/sqlite-speed-before-incremental-index.json)、[容量の変更前](../measurements/wasm-build-size-before-secondary-index.json) / [変更後](../measurements/wasm-build-size-before-incremental-index.json)、[アプリの変更前](../measurements/aot-before-secondary-index.json) / [変更後](../measurements/aot-before-incremental-index.json)を保存する。CPU 生プロファイルは実行ごとのディレクトリに保持する。
