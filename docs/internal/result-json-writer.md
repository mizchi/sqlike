# 型付き結果JSONの直接出力

2026-11-17、0.1.2以降の未リリース変更。AOT / binary definedと、通常SQLの列位置順の結果出力に直接writerを追加した。型付きABIの新設ではなく、従来のCell JSON形式をそのまま作る最適化である。

## 変更範囲

以前は各CellからJson object / Mapを作り、行と結果全体のJson配列へ詰め直してからstringifyしていた。新しい`write_result_cell`は一つのStringBuilderへ書き、BLOBもbyte配列から直接出力する。AOTはStatementのvisible bindingを一度ずつ読み、行・Cellの中間Json配列を作らない。

INTEGERは十進文字列、REALは数値または既存のInfinity token、負のゼロは`-0.0`、TEXTはJSON文字列、BLOBは0〜255の配列、NULLは`{"t":"null"}`のまま。TEXTのescapeと有限REALの数値表記には従来のcore JSON formatterを使う。SQL実行で作った結果Environmentと最終出力文字列は保持し、実行器を逐次cursorへ変更したわけではない。公開enum・Mapの内部表現をJSへ露出しない。JS / Wasm GCは同じ実装を使う。

`names`、列位置・重複名、hidden bindingの除外、空結果、`readonly` / `changes`、失敗時のerror / codeを維持する。object形式のSQL結果は、同名列の後勝ちとkey順序を含む既存処理を残す。bind parse、保存codec、SQLのJSON関数は置き換えない。

## 比較

変更前はv0.1.2（`b1982fc73a4e24f299d550bd26e031d427e325fa`）の同じローカルrelease出力を保存し、変更後と同じChromiumページで交互に実行した。100 / 1,000 / 5,000行、各7サンプル。JSON AOT / binary definedのJS / Wasmと、catalog選択後の4経路を検査する。新しい丸め関数もこのsourceに含まれるが、以下のworkloadでは使わない。

<!-- result-writer-speed:start -->
5,000行、µs / 操作、7サンプル中央値。前 → 後。

| 経路 | PK hit | PK miss | 実変更UPDATE | 式＋RETURNING |
| --- | ---: | ---: | ---: | ---: |
| aot/js | 2.18 → 1.20 | 1.04 → 0.77 | 2.81 → 2.53 | 3.89 → 3.00 |
| aot/wasm | 1.51 → 1.19 | 0.86 → 0.79 | 2.39 → 2.19 | 3.17 → 2.90 |
| defined/js | 2.17 → 1.14 | 1.04 → 0.76 | 2.86 → 2.55 | 3.97 → 3.10 |
| defined/wasm | 1.49 → 1.12 | 0.85 → 0.75 | 2.33 → 2.10 | 3.07 → 2.83 |

このfixtureのPK hitはJSで約45〜47%、Wasmで約21〜25%短縮した。式＋RETURNINGはJSで約22〜23%、Wasmで約8%短縮した。全SQL / 全入力への改善率ではなく、通常SQLのparser費用の削減としても扱わない。
<!-- result-writer-speed:end -->

全サンプル・source / artifact hashは[`result-writer-paired.json`](../../measurements/result-writer-paired.json)。PK検索の返り値、RETURNINGと失敗後を含む全行の値・型はnative SQLiteと照合する。更新のbindは測定区間をまたいで継続し、同値書込と実変更を分ける。起動・永続化・ネットワーク・強制GCは計時に含めない。SQLite自体との比較は別の[`sqlite-speed-current.json`](../../measurements/sqlite-speed-current.json)に記録する。

<!-- result-writer-size:start -->
engine単体のJS、minified未圧縮 / Brotli quality 11、単位B。丸め4関数の追加も含む合計差。

| 構成 | minified 前→後 | Brotli 前→後 | Brotli増分 |
| --- | ---: | ---: | ---: |
| AOT + SQLite writer + LTX | 595,044 → 596,369 | 111,886 → 112,305 | +419 |
| SQLike dynamic SQL | 623,870 → 625,026 | 117,132 → 117,508 | +376 |
| Litestream | 157,720 → 157,720 | 38,291 → 38,291 | +0 |

[追加前の記録](../../measurements/result-writer-before/wasm-build-size-current.json) / [追加後](../../measurements/wasm-build-size-current.json)。アプリの配信総量・catalog / host込みの値は別にREADMEへ記録する。
<!-- result-writer-size:end -->

中間Json / Mapを省いたことはコード上の変更範囲であり、メモリ削減率の保証ではない。保持heapとピークは既存のDB / 行ストア計測を更新するが、writer単独のallocation量は分離測定していない。

## 検証と後続

[`result_writer_wbtest.mbt`](../../packages/sqlike/src/result_writer_wbtest.mbt)で旧Cell encoderとの一致、int64境界、最小非ゼロREAL・最大REAL、無限大、負のゼロ、NUL / 制御文字 / Unicode、全256 byte、hidden bindingと重複位置を検査する。既存のAOT・positional・Drizzle・native差分・Chromium / offlineテストも通す。

CPU集計器も新しい`write__result__row` / `write__result__cell`のスタックをJSONへ分類するよう更新した。子の整数変換・buffer処理が単にotherへ落ちる回帰を固定テストで検出する。サンプリングと最も内側の分類を使うため、厳密なフェーズ時間や削減可能率ではない。

既存JSON ABIの出力側を減らした段階であり、[JS向けの直接ABI](json-abi.md)は未実装。通常SQLのparse / prepare、列名JSONの再利用、object形式の出力、二次索引のキー移動が次の候補になる。bind decoderを差し替える場合は、以前の試験で見つかった不正サロゲートの拒否条件も維持する。

`--before-dir`にはv0.1.2 checkoutでJS / Wasm GCをrelease buildした`runtime.js` / `runtime.wasm`と`defined.js` / `defined.wasm`を保存する。対応するartifact hashはpaired reportに記録する。別OSのCI配布物とローカル出力が同一だとは仮定しない。

```sh
just aot-update-bench --before-dir=/tmp/sqlike-012-before-marshal --output=measurements/result-writer-paired.json
just p0-measure
just bundle-size
LITESTREAM_BIN=/path/to/litestream just p0-check
```
