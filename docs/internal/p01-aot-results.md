# P01: AOTの実行準備と結果変換の改善

2026-11-15、開発版0.0.1。固定schemaで検証したSELECTの出力メタデータ・行layout・単純な射影の列位置をProgram内で再利用する。JSON ABIと`moon-aot@1`の形式は維持した。[改善台帳](status-and-improvement-plan.md)のP01に対応する。

このページの数値・JSONはP01完了時点へ固定した。現行の保存形式・計測は[S01](column-delta.md)を参照する。

## 採用した変更

[Program / Query](../../packages/sqlike/src/full/prepared.mbt)に、シリアライズしないprepared metadataを追加した。Program読み込み時の検証で得た出力を保持し、反復実行時の`selection_template()`と単純射影の列位置解決を省く。行・Table・Store・bind値・時計・connection counterは保持しない。cloneでProgramを共有しても、各実行は現在のStoreから候補を取得する。schemaの変わる動的SQLは従来の検証を続ける。

[JSON入口](../../packages/sqlike/src/full/aot.mbt)は、decode済みの値をStatementのbind領域へ直接入れる。JSONから新しく生成したBLOBを再コピーせず、途中のValue配列と各bindの重複した状態検査を省く。結果は可視bindingを一度走査してCell化する。利用側が所有するBLOBを受け取る公開`Statement::bind()` / `column()`のコピー契約は維持する。公開column取得でもfilter用配列を作らない。

Statement自体の保持は採用しなかった。生成・破棄は変更前の分離計測で約0.03µsで、実行中の名前解決より小さい。現在も呼び出しごとにfinalizeし、失敗したbindや大きな結果をnamed queryのキャッシュへ残さない。WHEREの一般式・JOIN・更新の式まで列位置へ変換する実装や、型付きABIの新設は今回の範囲に含めない。

## 分離計測

[whiteboxベンチ](../../packages/sqlike/src/full/aot_bench_wbtest.mbt)を変更前に追加して採取した。1,000行のPK検索、3列を返すケース。JSはNode 24.22.2、Wasm GCは`moon bench`の標準runner、Moon 0.1.20261104のrelease build。平均µs/操作。**各行は独立したmicrobenchmarkで、合算した値をABI全体の内訳としない。** setupは計時外、必要なreset / finalizeと`keep()`は計時内に含む。

| 区間 | JS 前→後 | Wasm GC 前→後 |
| --- | ---: | ---: |
| query取得・prepare・finalize | 0.029 → 0.053 | 0.031 → 0.038 |
| JSON decode・公開bind・reset | 0.298 → 0.291 | 0.277 → 0.283 |
| 公開Statementのstep・reset | 2.480 → 0.262 | 2.840 → 0.165 |
| 公開column取得・JSON結果生成 | 1.220 → 1.100 | 0.832 → 0.790 |
| aot_execute JSON ABI全体 | 4.350 → 1.690 | 4.010 → 1.220 |

bind / columnの分離probeは公開Statement経路であり、改善後のAOT入口の直接変換とは異なる。ABI全体のprobeには直接変換を含む。CLIのWasm runnerとブラウザでは文字列境界やJITが異なるため、次のChromium値と同一視しない。

生出力: [変更前JS](../../measurements/p01-before/aot-phases-js.txt) / [Wasm](../../measurements/p01-before/aot-phases-wasm.txt)、[変更後JS](../../measurements/s01-before/aot-phases-js-current.txt) / [Wasm](../../measurements/s01-before/aot-phases-wasm-current.txt)。変更前のChromium point profileでは、列名解決・正規化への帰属が約28%だった。[変更前の速度・profile](../../measurements/p01-before/sqlite-speed-profile.json)に成果物hashと採取条件も保存した。

## Chromiumでの比較

Apple M5 / Chromium 158、1,000行のmemory DB。7サンプル中央値、µs/操作。bindは事前JSON化、SQLikeは結果JSONのdecode込み、SQLite WASMはpreparedを再利用し列型を取得する。保存・RPC・起動は含まない。同じSQLite実装も同時採取し、環境の変動と区別する。

| 処理 | JS 前→後 | Wasm GC 前→後 | SQLite 前→後 |
| --- | ---: | ---: | ---: |
| 主キー検索 | 4.97 → 2.15 | 4.79 → 1.56 | 1.42 → 1.42 |
| 主キーmiss | 3.60 → 1.16 | 4.09 → 0.99 | 0.46 → 0.46 |
| 索引range・10行 | 15.87 → 11.45 | 12.06 → 8.12 | 10.56 → 10.48 |
| rowid順LIMIT 10 | 13.47 → 9.79 | 10.30 → 6.43 | 9.50 → 9.37 |
| SUM＋COUNT | 18.17 → 16.90 | 11.64 → 10.86 | 21.84 → 21.38 |
| 全1,000行 | 1,020.83 → 874.55 | 598.80 → 546.15 | 903.57 → 900.00 |
| 1行UPDATE | 5.37 → 5.38 | 3.68 → 3.49 | 1.28 → 1.28 |

PK検索の所要時間はJSで57%、Wasmで67%減り、missは68% / 76%減った。現在のPK検索はSQLite比で約1.51倍 / 1.10倍。missや更新は依然差があり、全処理でSQLiteより速いという結果ではない。

100行でもpointは4.60 → 2.30µs / 4.46 → 1.69µs、scanは101.27 → 87.93µs / 61.42 → 53.33µs。5,000行のscanは5,744.44 → 4,800.00µs / 3,125.00 → 2,883.33µsだった。JS UPDATEの中央値は条件別に0.2〜3.1%増、Wasmは2.8〜11.4%減。JSの前後サンプル範囲は重なり、更新の改善・有意な退行の判定はしない。対象表のO(N)コピーは今回省いていない。

[変更前の全サンプル](../../measurements/p01-before/sqlite-speed-profile.json) / [変更後の全サンプル・profile](../../measurements/s01-before/sqlite-speed-current.json)。profileは時間採取後の別runで、今回の変更後は集約・LIMIT・更新を採取した。dynamic経路、100行＋無関係な5,000行、索引移動も同じレポートに残す。

## 配信量と保持メモリ

Brotli quality 11。アプリはpage・Worker・precache・Program・SDK込み、ライブラリは全exportを残した単体であり、両者を合算しない。

| 対象 | 前→後 | bytes差 |
| --- | ---: | ---: |
| AOT実アプリ | 106.98 → 107.12 KiB | +147 |
| dynamic SQLike実アプリ | 163.77 → 163.79 KiB | +21 |
| AOT＋SQLite writer＋LTX / JS | 113.73 → 113.42 KiB | −317 |
| 同 / Wasm GC | 141.58 → 141.65 KiB | +65 |
| SQLike dynamic全API / JS | 121.08 → 121.15 KiB | +74 |
| 同 / Wasm GC | 153.32 → 153.59 KiB | +276 |

Litestream単体はJS 42,864 B / Wasm 49,950 Bで変わらない。圧縮率やbundle境界の差があるため、実行コードの追加量だけに換算しない。[実アプリ](../../measurements/s01-before/aot-current.json) / [単体](../../measurements/s01-before/wasm-build-size-current.json) / [機能選択別](../../measurements/s01-before/sqlike-feature-profiles-current.json)を再採取した。

notes Programは**20,049 B**、SHA-256 **`a6af7a52769d67773842aae483fcb856b46f628e31180d44afa14d2201bc2de2`**で従来と同一。runtimeのexport集合・parser除去を回帰検査し、新しいmetadataを既存の画像やProgramへ保存していない。

同じ100行・64 B payloadの計測用アプリでは次の値を観測した。通常デモのWorker構成とは異なるmain-threadの非同期adapterで、RPC・同期通信を含まない。7サンプル中央値、保持heapは別の416更新後のGC値から初期化前baselineを引いた値。

| profile | point read µs 前→後 | durable更新 µs 前→後 | 保持heap MiB 前→後 |
| --- | ---: | ---: | ---: |
| plain | 119.50 → 107.00 | 316.00 → 284.00 | 2.22 → 2.21 |
| indexed-trigger | 120.50 → 111.00 | 856.00 → 744.00 | 2.54 → 2.56 |

保持heapに約14 KiBの減少 / 26 KiBの増加を観測したが、Program metadataだけの割当を分離した値ではない。観測した範囲では大きな増加はなく、全DBの常駐メモリを減らした実装でもない。サンプリング最大も[全記録](../../measurements/s01-before/release-app-current.json)に残したが、GC頻度や採取間隔で変わり、RSSや真の一時ピークの保証に使わない。main-thread adapterでは複製・proof生成などの費用が残り、memory engineのPK検索短縮率をそのまま適用できない。

strict IDB、1,000行・1行更新のcheckpoint込み平均は、64 B payloadでsnapshot / 行差分 / ページ差分が1.678 / 0.322 / 5.585ms、4 KiB payloadで14.877 / 0.403 / 49.593ms。提出量は変更前と同一であり、保存形式はまだ最適化していない。[IDB計測](../../measurements/s01-before/indexeddb-speed-current.json)。DOの型保持費用と全SDKの起動・保持も再採取し、[完了証拠](../../measurements/s01-before/p0-completion.json)でsource / artifactの鮮度を確認した。

## 互換性と再現

[nativeとの回帰テスト](../../tests/aot-prepared.test.ts)はJS / Wasmの双方で、bindのINTEGER / REAL / TEXT / NULL / BLOB切替、残余predicate、可変LIMIT、CTEと相関式、重複列名と隠しrowidを比較する。不正bind・失敗UPDATEの次の呼出し、savepoint rollback、clone・restore・旧image再読込も検査する。時計とconnection counterはprepared metadataに固定されないことを確認した。

MoonBit 43件×JS / Wasm、Node 250件、Chromium E2E 47件、型チェック・本家Litestream復元を通過。厳密差分は566ケース×8経路で不一致0、出力監査もJS / Wasm / Chromium各432一致・270 atomic拒否・誤出力0だった。従来の未対応範囲は一致へ合算せず、全SQLite機能互換とは判定しない。

```sh
just aot-phase-bench
just sqlite-bench --profile-queries=point,miss,constant
just p0-measure
LITESTREAM_BIN=/path/to/litestream just check
just differential-audit
pnpm exec tsx scripts/check-p0.ts --record
```

改善前のP0計測は[p01-before](../../measurements/p01-before)へ保存した。未対応機能を拒否する出力契約と、実験用LSM / FTSを通常配信へ含めない境界は継続する。次の候補はS01の変更列差分で、大きい未変更TEXT / BLOBの永続化費用を減らす。
