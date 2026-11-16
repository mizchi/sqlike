# SQLike 改善計画

現行の再計測は[P0結果](p0-results.md)を参照。以下は以前の実装・計測の記録である。

**今後の着手順・完了条件は[対応範囲と改善台帳](status-and-improvement-plan.md)へ集約した。** このページは実施順と当時の測定を残す記録。末尾を含む性能・容量は出力互換ガード / adapter修正前の値。V01での再採取は完了し、[P0結果](p0-results.md)に現行の基準と比較を記録した。

最新の機能追加は[一般アプリ向けSQL・JSON / 日時・window・移行と任意の全文検索](sqlike-app-features.md)。主キー専用探索・slot map・copy-on-writeは実装済みで、式 index の検索高速化、変更表内のコピー、prepared / ABIの固定費は残る。

最新の保存方式の追加実験は [MoonBit LSM](lsm-experiment.md)。ordered KV として独立実装し、全件保持 journal と比較した。大きな値の保持メモリは減るが、検索と compaction のコストがあり、既存の行ジャーナルを維持する。SQL / LTX 接続はまだ行っていない。

2026-11-14。[SQLite WASM 比較](sqlite-performance.md)と CPU profile を基準に、効果だけでなく差分の大きさ、互換性の証明、追加状態、配信量を含めて順番を決める。性能改善の基準値は [変更前](../../measurements/sqlite-speed-before-optimization.json)、容量は [変更前](../../measurements/wasm-build-size-before-optimization.json)に固定した。

## 実施順序

| 順 | 改善 | 期待する効果 | 実装・検証コスト | 状態 |
| --- | --- | --- | --- | --- |
| 1 | 名前解決の filter 配列を除去し、検索名を1度だけ正規化する | 全 SELECT / DML の共通ホットパスを削減 | 小。列優先順位・曖昧性・ASCII case folding を固定 | 完了 |
| 2 | 行の評価用メタデータを表ごとに1度作り、値だけ差し替える | affinity・隠し rowid・主キーの毎行再計算を除く | 小。非公開の実行用データのみ。schema / dump 形式を変えない | 完了 |
| 3 | 単純な SELECT の候補行限定と LIMIT 早期停止 | 主キー1件・空検索・LIMIT 10 の全行評価を除く | 中。単一実表・単純な射影など証明できる範囲に限定 | 完了 |
| 4 | 単一 rowid の UPDATE / DELETE の候補限定、DML 退避の共有 | 全行の式評価と、無関係な行の deep copy を減らす | 中。変更前の行を不変として扱える範囲をテストで証明 | 完了。変更されない一意キーの再検査と、UPDATE の行配列全体の map も除去 |
| 5 | 主キー・二次索引の実行用データ構造 | 線形の候補走査を探索に置き換え、範囲検索を改善 | 大。挿入・更新・削除・restore・rollback の整合性と容量増を要検証 | 複合・降順・部分の列 index と増分更新、主キーhash / slot mapを実装。式 index の検索高速化は残る |
| 6 | AOT の列位置・スコープの固定、prepared handle / 型付き ABI | 残った列解決・JSON・statement 再生成を除く | 大。artifact の互換性と public API 設計を伴う | 単純 SELECT の列位置を行ループ前に固定済み。artifact / ABI 変更は保留 |

索引全体は効果が大きいが、最初に低コストの共通処理と、追加の索引状態を持たない候補限定を進める。段階3の rowid 候補走査が配列の線形探索なら、その事実を結果へ明記し、O(1) の索引を実装したとは扱わない。各段階後に残ったホットパスを確認し、後半の順位を見直す。

## 開発・採用条件

探索 → Red → Green → Refactoring の順。新しい helper や実行経路には先にテストを追加し、既存動作を保つ変更は基準値を性能上の Red とする。型付き結果、列位置、並び順、空集合での準備エラー、制約違反後の状態を native SQLite と照合する。

公開 API と保存形式を変えず、パーサなしの AOT を維持する。最適化の前提が成立しない SQL は既存経路を使う。WHERE の affinity、rowid のシャドーイング、ORDER BY の alias、LIMIT/OFFSET、CTE、相関参照、WITHOUT ROWID、外部キー、文の rollback を検証対象にする。

段階ごとに MoonBit JS / Wasm GC と native 差分テストを通す。まとまった変更後に同じ Chromium workload を測り、JS / Wasm、動的 SQL / AOT、更新・無関係なテーブルの条件を比較する。速度改善を計測ノイズと区別し、配信量も再測定する。根拠の薄いキャッシュや、互換性を変える近道は採用しない。

## 実施結果

2026-11-15、上の1〜4を実施した。1 / 2の時点で主キー検索は JS 948.21 → 384.67 μs、更新は992.86 → 379.72 μsになった。[中間測定](../../measurements/sqlite-speed-after-resolution.json)。その後に候補限定・早期停止・行値共有を追加し、再プロファイルから単純射影の列位置固定と、変更された一意キーだけの検査も追加した。

### 第1段階の測定

1,000行、メモリ DB、7サンプルの中央値、単位は μs/操作。計測器・workload hash・環境は変更前と同一。SQLike は AOT、SQLite は prepared の再利用。倍率は丸める前の値から算出。

| 処理 | JS 変更前 → 後 | JS 改善倍率 | Wasm GC 変更前 → 後 | Wasm 改善倍率 |
| --- | ---: | ---: | ---: | ---: |
| 主キー検索 | 948.21 → 5.89 | 160.9x | 988.46 → 5.41 | 182.7x |
| 存在しない主キー | 942.11 → 5.24 | 179.8x | 1,003.85 → 5.01 | 200.5x |
| LIMIT 10 | 3,585.71 → 21.89 | 163.8x | 4,383.33 → 12.67 | 346.0x |
| 全1,000行取得 | 4,840.00 → 1,163.41 | 4.2x | 5,330.00 → 686.49 | 7.8x |
| 1行更新 | 992.86 → 8.28 | 119.9x | 1,016.00 → 4.16 | 244.4x |
| 範囲検索・10行 | 1,364.86 → 773.13 | 1.8x | 1,590.32 → 1,183.72 | 1.3x |
| sum / count | 645.68 → 241.85 | 2.7x | 566.32 → 247.76 | 2.3x |

同じ最終測定の SQLite WASM は、主キー検索1.67 μs、LIMIT 10 が10.80 μs、1行更新1.46 μs。SQLike には引き続き差がある。全行取得は SQLite の列ごとの型取得・BigInt 変換、SQLike の一括 JSON decode という異なる API 境界を含み、SQL VM 単体の優劣とは扱わない。

主キー候補の探索は rowid のスカラー比較による線形走査のまま。実装したのは不要な全行評価の除去であり、永続的な索引や O(1) 探索ではない。LIMIT も raw 行参照のコピー・ソートは残る。対象外の JOIN、GROUP BY、DISTINCT、window、複雑な並び順などは従来経路を使う。

### 実装と互換性

- [名前解決](../../packages/sqlike/src/evaluate.mbt)は投影列の優先順位、曖昧な列、excluded の扱いを保ったまま、一時配列を除去した。行のメタデータは値と分離して再利用する。
- [実行用の補助処理](../../packages/sqlike/src/query_plan.mbt)は単純な実表 SELECT に限定する。整数 rowid / INTEGER PRIMARY KEY の等価条件では候補だけを評価し、rowid 順を証明できる場合は LIMIT までで停止する。ORDER BY の alias と `*` の優先順位、実列による rowid のシャドーイング、相関参照を検証した。
- 単純な射影は列位置を実行開始時に決定し、行ループでは格納値・rowid・定数だけを読む。artifact 形式、public API、パーサなしの AOT は維持した。
- 公開済み `StoredRow.values` は書き換えず、UPDATE と ALTER ADD COLUMN は行を作り直す。rollback / clone は mutable な容器だけを複製し、行値を共有する。スキーマ変更後の snapshot 分離、multi-row 制約違反、外部キー cascade、主キー更新と RETURNING を検証した。
- UPDATE の一意性は変更されたキーだけを再検査する。CHECK、外部キー、変更された UNIQUE キーの検査は引き続き実行する。

[追加の MoonBit テスト](../../packages/sqlike/src/optimization_wbtest.mbt)と [native 差分テスト](../../tests/sqlike-optimization.test.ts)で Red → Green を確認した。`LIMIT` の後に評価不要になる行が overflow を起こすケースも native と一致するようになった。

最終の `LITESTREAM_BIN=… just check` は MoonBit **18件×JS / Wasm GC**、Node **126件**、Playwright **38件**、型チェックを通過した。本家 Litestream による生成 LTX の復元も含む。既存コーパスと、計26 workload ×6経路の型付き結果・更新後状態を確認した。

### 容量

同じ全公開 API を残したライブラリ単体の Brotli は、AOT JS が74.38 → **75.85 KiB**、Wasm GC が94.18 → **95.65 KiB**。どちらも **+1.47 KiB**。動的 SQL の JS は74.80 → 76.37 KiB、Litestream 自体は変更なし。[容量の変更前](../../measurements/wasm-build-size-before-optimization.json) / [変更後](../../measurements/wasm-build-size-before-secondary-index.json)。`just build-size` で再計測できる。

実アプリの AOT 初回転送も、空の保存領域・新しい Chromium プロセスで各3回再測定した。73.16 → **74.30 KiB（+1.14 KiB）**。ページ・Worker・事前ビルド済みプログラム・保存処理・LTX を含み、オフライン再読込も通過した。[アプリの変更前](../../measurements/aot-before-sqlike-optimization.json) / [変更後](../../measurements/aot-before-secondary-index.json)。

### 次の判断

追加の索引状態を導入する前に、低コストの改善を採用できた。この時点では JS 773 μs / Wasm 1,184 μs、SQLite 12.17 μsで、次の優先対象を **二次索引による範囲検索**とした。

全行取得のプロファイルでは列名解決が約54% → 0.2%、JSON と認識できた部分が約43%になった。ABI の見直しはこの結果を基準にする。無関係な表がある更新では、残った行参照コピーの割合が高い。ここから先は索引の更新・rollback 整合性、undo journal、artifact / ABI のバージョン設計を伴うため、別段階として計画に残す。

[第1段階の全サンプル・CPU 集計・profile へのパス](../../measurements/sqlite-speed-before-secondary-index.json)、[候補限定後](../../measurements/sqlite-speed-after-candidates.json)、[射影位置の固定後](../../measurements/sqlite-speed-after-projection.json)も保存した。最適化前の CPU 生プロファイルの一部は再計測で上書きされ、元の時間サンプル・重み付き CPU 集計は保存できている。今後の生プロファイルは実行ごとのディレクトリへ出力し、上書きを避ける。

## 第2段階：単一列の二次索引

2026-11-15、[二次索引の範囲検索](sqlike-secondary-index.md)を実装した。1,000行の温まった範囲検索は JS **773.13 → 15.92 μs（48.6倍）**、Wasm GC **1,183.72 → 12.24 μs（96.7倍）**。同じ測定の SQLite WASM は11.28 μsだった。

実行用索引を保存形式と分離した。この段階では対象テーブルの変更・スキーマ変更・rollback・restore で無効化していた。最大4索引を保持し、再利用中は二分探索する。単一列比較の AND と昇順検索に限定し、その他は従来経路を使う。

書き込み後には再構築が必要なため、1,000行の「索引列を変更→10行検索」は JS **42.75 μs** / Wasm **27.69 μs**、SQLite **13.16 μs**。初回 API 呼び出しも別に記録した。この測定を受けて **索引の増分更新**を優先した。実装と結果は次節に記す。複合・降順・主キー専用索引の一般化と ABI 改善は引き続き候補とする。

AOT ライブラリの Brotli は JS **+1.36 KiB**、Wasm **+1.98 KiB**、実 AOT アプリは **+1.50 KiB**。MoonBit 各24件、Node129件、ブラウザ38件と型チェック、本家 Litestream 復元を通過した。[詳細と全測定](sqlike-secondary-index.md)を参照。

## 第3段階：索引の増分更新

2026-11-15、[構築済み索引への行差分の適用](sqlike-incremental-index.md)を実装した。INSERT / UPDATE / DELETE、UPSERT / REPLACE、cascade が変更行だけを二分探索して更新する。前後の並び順を保てる場合は行参照をその場で差し替え、順序が変わるときだけ配列を移動する。未構築の索引は作らず、rollback / clone / restore のキャッシュ分離と保存形式を維持した。

「索引列を変更→10行検索」の中央値は1,000行で JS **42.75 → 23.61 μs（1.81倍）**、Wasm **27.69 → 15.62 μs（1.77倍）**。5,000行では JS **131.44 → 40.31 μs（3.26倍）**、Wasm **78.87 → 22.62 μs（3.49倍）**。100行では改善していない。索引の両端間を移動する測定も追加し、配列移動を要する場合の時間を別に記録した。

AOT ライブラリの Brotli は JS **+0.48 KiB** / Wasm **+0.46 KiB**、実 AOT アプリは **+273 bytes（76.07 KiB）**。MoonBit 各26件、Node130件、ブラウザ38件、型チェックと本家 Litestream 復元を通過した。

この結果から **行参照配列の全体 map を特定行の差し替えへ置き換える**案を優先した。この段階の JS AOT 更新プロファイルでは1,000行でその self time が約25%を占め、追加の永続形式や索引なしで改善できる候補となった。続いて、無関係な行までコピーする `copy_store` の対象表限定・copy-on-write を検討する。これらが済んでから主キー専用索引や ABI のコストを再評価する。

## 第4段階：行参照配列の差し替え

2026-11-15、[replace_table_row](../../packages/sqlike/src/index_cache.mbt) の全体 map を除去した。rowid が一致する位置を見つけ、その接続が所有する配列の1要素だけを差し替えて終了する。UPDATE と UPSERT の共通処理に適用し、JS / Wasm GC、動的 SQL / AOT の両方で使う。行値は引き続き不変として扱い、索引には従来どおり行差分を適用する。

`candidate_rows` の候補配列と `copy_store` の退避配列は別に所有するため、走査中の候補や clone / rollback の復元先は書き換えない。公開 API・論理画像・コンパイル済み artifact の形式は変えていない。主キー候補の線形探索・差し替え位置の線形探索・文の退避コピーは残るため、書き込み全体が O(1) になる変更ではない。

### 速度と容量

同じ Apple M5 / Chromium 158 / Moon release、同じ SQL・データ・workload hash の7サンプル中央値。SQLike は AOT、SQLite WASM は prepared 再利用。単位は μs/操作で、事前に用意した bindings を使い、結果を共通の型付き Cell 配列へ戻すまでを含む。主計測は従来どおり156経路・1,092サンプルを検証する。

| 対象表の行数 | JS 変更前 → 後 | Wasm GC 変更前 → 後 | SQLite・今回 |
| --- | ---: | ---: | ---: |
| 100 | 4.91 → 3.75 | 3.97 → 2.86 | 1.28 |
| 1,000 | 8.20 → **5.94（1.38倍）** | 4.31 → **3.55（1.21倍）** | 1.35 |
| 5,000 | 24.62 → **16.99（1.45倍）** | 8.75 → **5.81（1.51倍）** | 1.38 |
| 100 ＋ 無関係な5,000行 | 9.67 → 8.10 | 4.08 → 3.53 | 1.24 |

更新対象は各表の中央の主キー1行。この主計測では、最初の検証で n を -7 に変更し、その後は同じ値を書き続ける。no-op 更新を省略する実装は加えていない。SQLite 側も1,000行で1.51 → 1.35 μsと変動しているため、表の倍率をコード変更だけによる厳密な効果とは扱わない。

値を -7 / -8 と交互に変更してから10行を検索する、更新と読み取りの組み合わせも測った。単位は μs/組。

| 行数 | JS 変更前 → 後 | Wasm GC 変更前 → 後 | SQLite・今回 |
| --- | ---: | ---: | ---: |
| 100 | 23.86 → 18.90 | 16.65 → 13.21 | 12.28 |
| 1,000 | 23.61 → 20.96 | 15.62 → 13.94 | 12.62 |
| 5,000 | 40.31 → 30.28 | 22.62 → 16.23 | 12.68 |

索引の先頭と末尾へ交互に移す場合も、5,000行で JS 47.03 → 38.67 μs、Wasm 22.16 → 19.73 μs。索引内の配列移動のコストは残る。温まった検索単独は1,000行で JS 15.68 μs / Wasm 11.67 μs / SQLite 11.02 μsだった。

全公開 API を残した AOT ライブラリ単体の Brotli は JS **77.69 → 77.72 KiB（+26 bytes）**、Wasm **98.09 → 98.03 KiB（-59 bytes）**。実 AOT アプリの初回転送は **77,892 → 78,030 bytes（76.07 → 76.20 KiB、+138 bytes）**。新しい Chromium プロセスと空の保存領域で各3回測り、オフライン再読込も通過した。Litestream 単体は変わらない。

[MoonBit テスト](../../packages/sqlike/src/optimization_wbtest.mbt)で、配列を再利用しながら変更前の候補・checkpoint・clone の値を維持することを Red → Green で固定した。[native 差分テスト](../../tests/sqlike-index.test.ts)では複数行の主キー変更、同じ行への連続 UPSERT と RETURNING、CHECK / NOT NULL / 主キー違反後の rollback、索引・snapshot・restore を4経路で照合した。

`LITESTREAM_BIN=… just check` は MoonBit **27件×JS / Wasm GC**、Node **131件**、Playwright **38件**、型チェック、本家 Litestream での生成 LTX の復元を通過した。

### 次の判断と測定資料

JS AOT 更新の別採取プロファイルで、1,000行の `replace_table_row` の self time は約25% → 15%になった。今回の `copy_store` は約19%、主キー候補探索は約9%。100行の表に無関係な5,000行を足した場合は `Array.copy[StoredRow]` 自体が約57%を占めた。後者は JIT のインライン化で退避用の分類に現れないが、この workload とコードから退避配列のコピーが主因と判断する。サンプル帰属であり、削減可能な時間の保証ではない。

この時点では **copy_store の対象表限定・copy-on-write** を次の候補とした。現在の直接差し替えは接続ごとの行配列の所有を前提にしているため、単に退避用コピーを取り除かず、書き込み前の所有権と分離を明示して実装する。clone・複数行更新・DDL・外部キー cascade・文の途中失敗後の rollback を採用条件とする。主キー専用索引と ABI の変更は、その後に再評価する。

[速度の変更前](../../measurements/sqlite-speed-before-row-replacement.json) / [変更後](../../measurements/sqlite-speed-before-idb-delta.json)、[容量の変更前](../../measurements/wasm-build-size-before-row-replacement.json) / [変更後](../../measurements/wasm-build-size-before-idb-delta.json)、[アプリの変更前](../../measurements/aot-before-row-replacement.json) / [変更後](../../measurements/aot-before-idb-delta.json)。`just sqlite-bench` / `just build-size` / `just measure-aot` で再現でき、生の CPU profile は実行ごとの別ディレクトリに保持する。

## 優先順の見直し：IndexedDB への差分 flush

ユーザーの IndexedDB バックエンドの要望を受け、次はエンジン単体の最適化よりも **永続化経路の計測と差分 flush** を優先する。copy-on-write はそこで観測したコピー費用に応じて進める。この方針で第5段階を実装した。以下は着手時点の問題と計画であり、現在の構成・測定は次節と[IndexedDB保存の記録](indexeddb-persistence.md)を参照。

### 着手時点の構成

- SQLike / AOT は MoonBit の行配列と実行用索引をメモリに保持し、IndexedDB に論理画像を保存する。SQLite のページキャッシュを直接 IndexedDB に置く pager ではない。
- [AOT の書き込み](../../adapters/aot-database.ts)は private clone → SQL 実行 → 全量 `aot_dump` → DB 画像・SQLite base・LTX outbox を含む `SavedState` の全量 JSON 化 → IndexedDB commit の順。論理 DB の JSON 文字列をさらに JSON の文字列フィールドへ入れている。
- [MoonImageStore](../../adapters/moon-image-store.ts) は世代確認にも画像を含む `root` レコード全体を読み、更新後の画像全体を put する。サイズ確認の `TextEncoder.encode` も全量のバッファを確保する。動的 SQL はさらに保存専用 Worker へ画像を送る。
- 通常デモの既定 engine は SQLite WASM + OPFS。SQLike でも direct LTX の生 SQLite イメージキャッシュだけは [OpfsImages](../../adapters/opfs-images.ts) を使う。IndexedDB だけで動かす構成では、このキャッシュの保存アダプターも置き換える。

第1〜4段階の μs 計測はメモリ DB であり、IndexedDB・Worker RPC・flush の時間を含まない。既存の実アプリ測定には100回の逐次 durable 書き込みがあり、直近3回の合計時間は26.51 / 47.20 / 27.74 ms（中央値27.74 ms）。空 DB に100行を追加する測定であり、大きな DB の1行更新や flush の各処理の費用はまだ分離していない。

### 実施順序

1. **実ブラウザの永続化ベンチを追加する。** 100 / 1,000 / 5,000行の DB で1行更新、複数行の1トランザクション、checkpoint、再起動を測る。実行・clone / 退避・差分生成または dump・Worker 転送・IndexedDB commit を分け、提出バイト数とレコード数も記録する。エンジン単体の速さと durable ACK までの時間を別の KPI にする。
2. **変更行だけを取り出す契約を MoonBit 側に定義する。** 挿入・置換・削除の共通 helper で dirty な行・テーブルを追跡し、rollback で未確定の変更を捨てる。全量 dump 後に文字列を diff する方式では O(DB全量) の生成費用が残るため、差分の取り出しまで変更量に応じた処理を目指す。DDL / import / restore は初期段階では全量 checkpoint へ戻せるようにする。
3. **IndexedDB の保存をメタデータと差分・checkpoint に分ける。** 世代確認は小さなレコードだけを読む。データ差分・outbox・世代番号を同じ strict transaction で確定し、complete 後に成功を返す。失敗・世代競合・ACK 喪失は既存の契約を維持する。古い全量画像からの再開と、新しい保存形式の version を定義する。
4. **SQLite base / LTX をバイナリの不変レコードに分ける。** 毎回のデータ更新や ACK で base64 の全体を再保存しない。direct LTX の生画像も IndexedDB の chunk / 世代単位で保持し、候補と確定済み画像を区別する。checkpoint の公開後だけ古い世代を回収する。

実行時の読み取りはメモリに残し、IndexedDB のキー順序を SQL の affinity・照合順序の代わりに使わない。現状は行ストアなので、先に論理行差分を保存する。SQLite 互換ページの dirty-page flush と、そのページからの LTX 生成の共通化は pager / writer を増分化する別段階とする。

保存前後・再起動後の native 差分、DB と outbox の原子性、strict commit abort、古い世代からの書き込み、commit 後の応答喪失、途中で止まった checkpoint と回収、旧形式からの復旧を TDD の採用条件にする。


## 第5段階：IndexedDB 差分保存とインフラ境界

2026-11-15、[行after-imageジャーナルと定期スナップショット](indexeddb-persistence.md)をSQLike / AOTの既定保存にした。MoonBit側で変更を追跡し、通常commitでは全量dumpを作らない。IDBの世代確認も小さなrootだけを読む。128レコードまたは4 MiBでcheckpointへ戻し、DDL / import / restore、4,096編集超過も全量へ戻す。

[persistence-contract.ts](../../src/persistence-contract.ts) に非同期ImageStore、同期SQL用の保存ブリッジ、生レプリカ画像キャッシュの契約とfactoryを定義した。保存形式を解釈するエンジン側と、opaqueな差分・バイナリを原子的に保存する実装を分離する。factory注入により、ブラウザAPIなしの保存実装に差し替えても再開できる。SQLikeのdirect LTX画像もIDBに切り替え、旧OPFSからは必要時に移す。

同じJS AOT・SQL・データで、全量保存、行差分、SQLite 4 KiBページ差分をstrict IDB commitまで計測した。1,000行×64 B payloadの1行更新は平均 **1.708 / 0.195 / 5.939 ms**。5,000行では **8.596 / 0.242 / 31.028 ms**。定期checkpointを含む。現行のページ方式はファイル全体の再生成が支配的で、増分pagerを持つ実装全般の比較ではない。

幅4 KiBの1,000行で16行をまとめて更新すると、通常deltaの提出量は行差分68,301 B、ページ差分20,596 Bとなり、ページ方式が少ない。一方ACKまでは1.681 / 54.041 msだった。変更列だけの行差分と、ページwriterの増分化を今後の候補にする。

同じ幅4 KiBのケースのcommit完了後は、JS heapが全量保存10.01 MiB / 行差分6.20 MiB / ページ差分6.23 MiB、backing storageが0.03 / 0.03 / 8.33 MiBだった。GC後の単発観測で、OS RSSや一時的な最大値ではない。実行エンジンは全行を保持するため、メモリ上限をDBサイズから切り離すpager / LRUは未実装。

AOTライブラリ単体のBrotli増加は JS **+2.47 KiB** / Wasm **+3.52 KiB**。実AOTアプリは **79.75 KiB（+3.55 KiB）**。MoonBit各29件、Node139件、Playwright40件、型チェックと本家Litestream復元を通過した。旧画像の移行・途中失敗・世代競合・compaction・checkpoint / ACK喪失後の再開・JS/Wasm相互replayも含む。

次は変更列だけの差分で大きな未変更値の再送を減らす案と、`copy_store`の対象表限定・copy-on-writeを検討する。ページ方式は、全体再生成を避けるpager設計と上限付きキャッシュを定義してから再評価する。通常更新の提出量だけでなく、定期checkpointと大きなoutboxの最大保持量・復旧コストも採用条件にする。

[保存方式の全測定](../../measurements/p0-before/indexeddb-speed-current.json)、[最新のメモリ内SQL比較](../../measurements/p0-before/sqlite-speed-current.json)、[全公開APIのサイズ](../../measurements/p0-before/wasm-build-size-current.json)、[実アプリ](../../measurements/p0-before/aot-current.json)。`just indexeddb-bench`を追加し、既存の`just sqlite-bench` / `just build-size` / `just measure-aot`も再測定した。

## 第6段階：複合・部分 / 式 index と基本 trigger

2026-11-15、[定義・実行・保存・同期](sqlike-index-trigger.md)を順に追加した。列 index は複合の等値 prefix と範囲、混在方向の整列、逆方向の走査、部分 index の出入りに対応する。式 index は一意性と SQLite 保存までで、検索高速化には使わない。trigger は AOT に型付き AST として保持し、runtime の SQL parser は引き続き不要。

`just sqlite-bench` を再採取し、既存156経路・1,092サンプルと別採取の6 CPU profile を保存した。計測器・schema・workload の hash は[追加前](../../measurements/sqlite-speed-before-composite-index.json)と一致し、全経路の値・型・更新結果を native で検証した。1,000行・無関係な表なし・7サンプルの中央値、単位は μs/操作。SQLike は AOT、SQLite WASM は prepared の再利用。

| 既存の処理 | JS 追加前 → 後 | Wasm GC 追加前 → 後 | SQLite WASM 今回 |
| --- | ---: | ---: | ---: |
| 主キー検索 | 5.25 → 5.11 | 4.69 → 4.90 | 1.42 |
| 単一列 index 範囲・10行 | 13.83 → 14.90 | 10.93 → 11.88 | 10.42 |
| 1行更新 | 5.93 → 6.15 | 3.32 → 3.69 | 1.28 |
| 全1,000行取得 | 1,008.16 → 1,004.00 | 590.59 → 597.62 | 887.50 |

既存の範囲検索は JS 約8% / Wasm 約9%、更新は約4% / 約11%の時間増加が観測された。機能追加後の実測として残し、速度の改善とは扱わない。複合 index 自体の改善倍率や、trigger 付きアプリの保持メモリはこの既存 workload から主張しない。次の性能改善では、共通の単一列処理を簡略化する費用と、以前から残る主キー候補の線形探索・退避コピーを比較する。

全公開 API の AOT Brotli は JS **80.18 → 87.20 KiB**、Wasm **101.55 → 109.74 KiB**。既存 notes の実アプリは **79.75 → 85.51 KiB**。事前コンパイル済み program の20,049 Bと SHA256 は一致し、parser 除外・LSM 除外を維持した。追加機能を使わないアプリでの runtime 費用であり、index / trigger を増やした artifact の大きさは別になる。

MoonBit **40件×JS / Wasm GC**、Node **167件**、Playwright **42件**と型チェックを通過した。新しい index と trigger 副作用を含む LTX chain の本家 Litestream 復元も通過。バージョンは0.0.1のまま、U01〜U09全体を合格にしたものではない。

[速度の追加前](../../measurements/sqlite-speed-before-composite-index.json) / [追加後](../../measurements/p0-before/sqlite-speed-current.json)、[容量の追加前](../../measurements/wasm-build-size-before-composite-index.json) / [追加後](../../measurements/p0-before/wasm-build-size-current.json)、[アプリの追加前](../../measurements/aot-before-composite-index.json) / [追加後](../../measurements/p0-before/aot-current.json)。CPU 生 profile は実行ごとの別ディレクトリに保持する。

## 第7段階：一般アプリ向けSQLと任意の全文検索

2026-11-15、[SQLトランザクション・CAST・複合SELECT / INSERT SELECT・JSON / UTC日時・複合FK・移行・集約 / window / 再帰CTE](sqlike-app-features.md)を追加した。全文検索は独立した `mizchi/sqlike/fts` に置き、通常のSQL / AOTの配信へ含めない。検索データは確定したSQLテーブルから再構築する。

既存と同じ156経路・1,092サンプルの結果と更新後状態をnativeで検証した。以下は1,000行、無関係な表なし、7サンプルの中央値、単位はμs/操作。SQLikeはAOT、SQLite WASMはpreparedの再利用。

| 既存処理 | JS 追加前 → 後 | Wasm 追加前 → 後 | SQLite 今回 |
| --- | ---: | ---: | ---: |
| 主キー検索 | 5.11 → 6.15 | 4.90 → 5.90 | 1.71 |
| 範囲検索・10行 | 14.90 → 18.60 | 11.88 → 13.97 | 12.73 |
| 1行更新 | 6.15 → 8.28 | 3.69 → 4.57 | 1.60 |
| 全1,000行 | 1,004.00 → 1,271.05 | 597.62 → 732.84 | 1,123.91 |

JSは約20〜35%、Wasmは約18〜24%の時間増加を観測した。同じ測定のSQLiteにも約20〜27%の増加があり、すべてを機能追加の費用とは断定しない。処理ごとのSQLike / SQLite比は、主キー検索がJS約3.60倍 / Wasm約3.46倍で追加前に近く、JS更新は約4.79 → 5.16倍へ増えた。計測器・workload hashは同一で、別採取の6 CPU profileも保存した。次の速度改善では、未使用のwindow / transaction状態の割当、主キー候補の線形探索、退避配列を比較し、固定コーパスの意味を変えずに減らす。

AOT全公開APIのBrotliはJS **87.20 → 102.96 KiB**、Wasm **109.74 → 127.88 KiB**。既存notesアプリは **85.51 → 98.36 KiB**で、programの20,049 BとSHA256は同一。任意の検索はJS wrapper＋runtime単体 **36.61 KiB**、Wasm module単体 **46.68 KiB**として別計測した。実デモ100回の逐次durable書込は合計中央値 **30.90 ms**。検索・LSMのコードは通常版とlite版に含めない。

MoonBit各40件・Node191件・Playwright43件と型チェック、実Litestream復元を通過した。全機能監査の固定プローブ一致は90 → 162件、値の不一致は0件。未対応・未検証が残り、全互換ゲートは失敗のままにする。0.1.0の全シナリオ完了とは扱わず、0.0.1を維持した。

[速度の追加前](../../measurements/sqlite-speed-before-app-features.json) / [追加後](../../measurements/p0-before/sqlite-speed-current.json)、[容量の追加前](../../measurements/wasm-build-size-before-app-features.json) / [追加後](../../measurements/p0-before/wasm-build-size-current.json)、[アプリの追加前](../../measurements/aot-before-app-features.json) / [追加後](../../measurements/p0-before/aot-current.json)、[任意の検索](../../measurements/search-current.json)。


## 機能選択・RIGHT/FULL・STRICT・主キー専用索引

[選択APIと同期の契約](sqlike-feature-profiles.md)を追加した。JS/Wasmを隔離workspaceで生成し、不要な機能をcompile時に除く。通常の全機能entry、SQLite画像/LTX、既存programの互換性は維持する。PK索引は最大4テーブル分の派生mapとして保持し、行変更で差分更新する。INTEGER PKはrowid mapを共用し、二重の文字列キー保持・JSON化を省いた。

以下は同じChromium・メモリDBの全機能AOT。値は変更前→変更後の中央値、単位µs。

| 行数 | 検索 JS | 検索 Wasm | 更新 JS | 更新 Wasm |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 5.73→4.48 | 5.41→4.40 | 4.67→4.17 | 3.46→3.32 |
| 1000 | 6.15→4.79 | 5.90→4.96 | 8.28→5.79 | 4.57→3.62 |
| 5000 | 9.67→4.86 | 7.14→4.71 | 20.93→13.95 | 7.22→5.24 |

SQLite側も速度が変動しているため、絶対値だけで追加機能の効果を判断しない。5,000行のSQLite比では、検索JS **5.66→3.41倍**・Wasm **4.18→3.31倍**、更新JS **13.64→10.49倍**・Wasm **4.70→3.94倍**。100行のWasm更新はSQLite比 **2.51→2.82倍**で、追加の固定費が残る。すべての規模・処理が速くなったとは扱わない。156経路・1,092サンプルの型付き結果検証と6 CPU profileを[最新レポート](../../measurements/p0-before/sqlite-speed-current.json)、[比較前](../../measurements/sqlite-speed-before-feature-profiles.json)に保存した。

サイズは[生成プロファイル](../../measurements/p0-before/sqlike-feature-profiles-current.json)と[実アプリ転送](../../measurements/p0-before/aot-current.json)を分ける。AOTの今回の選択機能なしはJS Brotli **90.61 KiB** / Wasm **116.15 KiB**。画像・LTXを含む既存全公開APIは **106.65 / 132.92 KiB**、既存アプリのAOT初回転送は **101.41 KiB**。FTSは **36.61 / 46.68 KiB**の別配信のまま、LSMは実験専用のままとした。

MoonBit 41件×2target、Node 207件、Playwright 44件と型検査・実Litestream復元を通過した。AOTの生成SQLiteはnative integrity_checkとSTRICT/ANYの保存を検査し、JS/WasmのSQLite/LTX出力も一致した。catalog監査は固定probe一致166件、値不一致0件だが、全互換のexit 1は維持する。0.0.1を継続する。

今回のAOTアプリはcold ready中央値 **91.0 ms**、offline reload **39.9 ms**。100回の逐次durable書込 **23.95 ms**、100回の読取 **3.64 ms**、SQLite/LTX checkpoint **7.85 ms**。各3回の記録を残す。

## 差分修正後

2026-11-15。[12項目の差分修正](sqlite-differential-findings.md)に加え、追加監査の優先順1〜4を実施した。COUNT/SUM/TOTAL/AVGの直接走査、LIMITのrowid順cache、更新のslot map、変更表だけのcopy-on-writeを実装。接続カウンターをhost rollbackから分離し、SQL rollback後のPK cacheも無効化した。

1,000行のSUM＋COUNTはJS **253.93→18.26µs（13.9倍）**、Wasm **238.76→11.52µs（20.7倍）**。同じ測定のSQLiteは21.47µs。LIMITはJS17.09→13.70µs、Wasm11.72→10.13µs。100行＋無関係な5,000行のUPDATEはJS8.59→3.78µs、Wasm3.91→3.28µs。

5,000行のUPDATEはJS13.95→11.85µs、Wasm5.24→5.16µsで、SQLite1.33µsとの差が残る。変更表の配列コピーがO(N)のため、全UPDATEが一定時間になったとは扱わない。1,000行のWasm UPDATEには改善を確認できていない。次の順序は、変更表内のundo/paged構造、AOTのprepared状態と列解決再利用、型付き戻り値ABIを、改めてprofileとサイズで比較する。

[修正前の同条件](../../measurements/sqlite-speed-differential-audit-before-audit-fixes.json)、[修正後の全量](../../measurements/p0-before/sqlite-speed-current.json)、[同じ採取からの比較用抽出](../../measurements/sqlite-speed-differential-audit.json)。全公開AOT単体のBrotliはJS 111.32 KiB / Wasm 138.73 KiB、アプリ初回転送は105.11 KiB。

検証はMoonBit42件×JS/Wasm、Node221件、Playwright44件。差分ゲートは566ケース×8経路、結果不一致0件・未対応0件。SQLite全機能監査は一致170件・candidate-error182件・未検証/API欠落が残るためexit 1を維持し、バージョンは0.0.1のままとする。
