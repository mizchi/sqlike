# バンドルサイズの計測記録

現行の再計測は[R02](aot-ltx-upload.md)、行ストアの変更は[P02](row-store.md)、以前の列差分は[S01](column-delta.md)、AOT改善は[P01](p01-aot-results.md)を参照。以下は以前の実装・計測の記録である。

このページは**出力互換ガード・返却adapter修正前の計測**を記録する。以下の数値に対応するJSONは`p0-before`へ固定した。V01での現行ソース再採取は完了し、V01時点の値は[P0結果](p0-results.md)、その後の差分は[P01結果](p01-aot-results.md)を参照する。

2026-11-15、差分修正・集約直接走査・rowid順cache・slot map・copy-on-writeの追加後に再計測した。Node 24.22.2 / Chromium 158.0.8127.18 / Apple M5。KiB = 1,024 bytes、MiB = 1,048,576 bytes。Turso の実アプリ転送量のみ11-14の記録を使用する。

[LSM](lsm-experiment.md)は実験専用で、既定のバックエンドや通常版・lite版・Worker の配信バンドルには含めない。このページおよび通常のサイズ計測対象にも合算せず、単体サイズは実験レポートだけに記録する。production build は LSM モジュールの混入を拒否する。

[任意の全文検索](sqlike-app-features.md)も通常バンドルへ含めない。JSのSearchIndex wrapper＋検索runtimeは単体Brotli **36.61 KiB**、Wasm module単体は **46.68 KiB**。[別計測](../../measurements/search-current.json)に分離し、通常版・lite版の生成JSに検索画像formatの混入がないことも検査した。

## 実アプリの初回転送

| 構成 | 展開後レスポンス合計 | Brotli の実転送 |
| --- | ---: | ---: |
| SQLike AOT | 537.30 KiB | **105.11 KiB** |
| SQLike・SQL文字列版 | 766.57 KiB | **161.99 KiB** |
| SQLite WASM | 1.32 MiB | **474.54 KiB** |
| Turso WASM | 15.56 MiB | **3.63 MiB** |

ページ、Service Worker と precache、DB Worker、スキーマ・プログラム、選択した SDK の初期化までを含む。新しいプロセスと空のブラウザ保存領域で各3回、localhost のサーバーが Brotli quality 11 を返す。ボディの合計で、HTTP ヘッダーは含まない。全構成でオフライン再読込を検査した。

AOT は parser を配信せず、固定クエリ・SQLite writer・LTX reader / writer の必要部分と保存アダプターを含む。通常デモは同期 UI・SQL / Session・LTX 受信を含み、機能範囲が異なる。サイズ差のすべてを parser 除去の効果とは扱わない。Turso の SDK は任意選択であり、SQLike や SQLite の起動時には取得しない。

## ライブラリ単体

Vite で全公開 API を保持した ESM を minify。アプリは不要な API を除くため、この表をアプリの容量へ合算しない。gzip level 9 / Brotli quality 11。

| 対象 | 非圧縮 | gzip | Brotli |
| --- | ---: | ---: | ---: |
| `sqlike` 全公開 API | 819.82 KiB | 157.34 KiB | 119.09 KiB |
| `litestream` 全公開 API | 219.02 KiB | 51.12 KiB | 41.86 KiB |

SQLike は parser・SQLite reader を含む動的 SQL の公開 API、Litestream は LTX の生成・適用、Session codec・同期判定を含む。AOT で使う部分とは export の範囲が異なる。

## JS / Wasm GC のビルド差

同日の release build を、対象ごとに同じ全公開 export を保持して比較した。JS は Vite の library mode で minify、Wasm GC は Moon の release 出力を使い、追加の `wasm-opt` は適用していない。単位は KiB。gzip level 9 / Brotli quality 11。

| 対象 | JS minify | Wasm GC | JS gzip | Wasm gzip | JS Brotli | Wasm Brotli |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AOT + SQLite writer + LTX | 749.81 | 443.70 | 145.48 | 175.67 | 111.32 | 138.73 |
| SQLike・SQL文字列版 | 819.82 | 479.52 | 157.34 | 192.38 | 119.09 | 150.74 |
| Litestream | 219.02 | 129.65 | 51.12 | 59.06 | 41.86 | 48.78 |

この測定では未圧縮のWasmが約4割小さいが、Brotli後ではAOTが約24.6%、SQLikeが約26.6%、Litestreamが約16.5%大きかった。転送量はJSが小さい。[改善の履歴](sqlike-optimization-plan.md)には同時期のSQL実行速度も記録する。

最適化前のビルドでは Wasm の custom `name` section 除去もメモリ上で試した。元々29〜49 Bしかなく、AOT の Brotli は94.18 → 93.98 KiBで、差を埋める効果はなかった。[当時の記録](../../measurements/wasm-build-size-before-optimization.json)に残す。

この表はライブラリ単体であり、HTML・loader・worker・保存アダプター・アプリの事前コンパイル済みプログラムを含まない。AOT はパーサなし・SQLite writer と LTX を含むため、SQLike との列間の差をそのままパーサの容量とは扱わない。実アプリの JS は使う API だけを保持するため、上の AOT 初回転送105.11 KiBとも範囲が異なる。Wasm 版アプリ全体の初回転送は今回測っていない。

前回の一般アプリ向けSQLの追加時点では、AOT 単体の Brotli が JS **+15.76 KiB** / Wasm **+18.14 KiB**、AOT アプリ全体が **+12.85 KiB**。SQL 文字列版アプリは+16.95 KiB。既存 notes program は20,049 Bのままで SHA256 も一致する。[変更前のライブラリ](../../measurements/wasm-build-size-before-app-features.json)、[変更前のアプリ](../../measurements/aot-before-app-features.json)、[実装範囲](sqlike-app-features.md)と比較できる。Litestream のJS / Wasmは変更なし。

[計測値・SHA256・export 一覧](../../measurements/p0-before/wasm-build-size-current.json)を保存した。JS / Wasm の export 名一致、Wasm compile、gzip / Brotli の往復一致も確認した。

## 再現と根拠

```sh
just measure-runtime --memory=false
just measure-aot
just probe-web-platform
just build-size
```

- [全エンジンの実リクエスト・asset hash・サイズ](../../measurements/p0-before/runtime-current.json)
- [AOT の実リクエスト・artifact hash・サイズ](../../measurements/p0-before/aot-current.json)
- [Web 標準と配信構成の試作結果](../../measurements/web-platform-probe.json)
- [削減候補と互換性上の制約](web-platform-size.md)

今回はメモリ測定を行っていない。以前のメモリ記録は [変更前レポート](../../measurements/runtime-before-web-platform-review.json) に残した。


## 選択ビルドのサイズ

[機能プロファイルAPI](sqlike-feature-profiles.md)は、Moonの定数畳込み・到達性解析とJSのtree shakingを組み合わせる。以下は生成ランタイム単体のBrotliで、既存の全機能entryや実アプリ転送とは分けて測る。

| プロファイル | JS | Wasm GC |
| --- | ---: | ---: |
| AOT・今回の選択機能なし | 95.11 KiB | 121.30 KiB |
| AOT・選択実行機能すべて | 100.73 KiB | 128.01 KiB |
| AOT・SQLite画像/LTX込み | 111.19 KiB | 138.73 KiB |
| SQL文字列・今回の選択機能なし | 104.41 KiB | 133.58 KiB |
| SQL文字列・binary捕捉込み | 111.58 KiB | 142.08 KiB |

選択機能なしでも、既存のJSON・日時・window・二次索引などのcoreは残る。単独機能を足したときの圧縮差は辞書の影響で単調増加にはならない。全プロファイルの非圧縮・gzip・Brotliと実装除去の検査は[計測JSON](../../measurements/p0-before/sqlike-feature-profiles-current.json)を参照。今回の変更前は[ライブラリ](../../measurements/wasm-build-size-before-feature-profiles.json)、[実アプリ](../../measurements/aot-before-feature-profiles.json)に保存した。notes programは20,049 B、SHA256 `a6af7a52769d67773842aae483fcb856b46f628e31180d44afa14d2201bc2de2`のまま。

## 差分修正に伴う追加容量

今回の監査修正と高速経路の追加で、全公開AOTエンジン単体はBrotliでJS **+4.67 KiB**、Wasm **+5.82 KiB**。AOTアプリの初回転送は **+3.70 KiB**になった。[変更前エンジン](../../measurements/wasm-build-size-current-before-audit-fixes.json)、[変更前アプリ](../../measurements/aot-current-before-audit-fixes.json)、[修正範囲と速度](sqlite-differential-findings.md)を比較できる。notes programの20,049 BとSHA256は一致し、SQL parser・任意FTS・実験的LSMの配信範囲も維持した。
