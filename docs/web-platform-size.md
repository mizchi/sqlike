# Web 標準による削減候補

最新ビルドの初回転送は AOT 98.36 KiB、SQL 文字列版 SQLike 154.71 KiB、SQLite WASM 474.27 KiB。Turso は前回計測の3.63 MiB。任意の全文検索とLSMは通常バンドルから除外する。[計測の範囲](runtime-size.md)を参照。以下の API 置換試作は SQLike 実行最適化前のビルドで測った結果で、元の source hash を保存している。

試作は生成 JS と Vite の入力をメモリ上で置換し、同じ DB Worker の minify / gzip / Brotli を比較した。**本番のライブラリ・アダプターへは適用していない。** [probe-web-platform.ts](../scripts/probe-web-platform.ts)、[生データ](../measurements/web-platform-probe.json)に再現方法・source hash・基本ケースの比較結果を残す。削減量は同じ試作内の差であり、異なる試作同士を合算しない。

## 優先度が高い配信方法の変更

現在の Turso は `@tursodatabase/database-wasm/bundle` を使い、Wasm を Base64 で JS に含める。通常エントリは外部 `.wasm` を `fetch` する構成を持つ。

| Turso SDK の試作出力合計 | 非圧縮 | gzip | Brotli |
| --- | ---: | ---: | ---: |
| Wasm を JS 内包 | 15.14 MiB | 5.30 MiB | 3.54 MiB |
| 外部 `.wasm` | 11.44 MiB | 3.86 MiB | 2.62 MiB |

Brotli で **973,500 bytes（約0.93 MiB）**減った。アプリ全体では現在の3.63 MiBから約2.70 MiBになる見込み。ただしこれは出力 asset の合計で、変更後の実ブラウザ起動・OPFS・thread Worker・オフラインキャッシュを検証した転送量ではない。

効果は Base64 内包をやめることによる。`WebAssembly.instantiateStreaming()` 自体が Wasm の容量を減らすわけではない。SDK の WASI 初期化を維持したうえで、外部配信と streaming 初期化を検討する。[標準 API](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static)

## Web API への置換

| 試作 | AOT DB Worker の Brotli 削減 | 検証状態 |
| --- | ---: | --- |
| `Uint8Array.fromBase64` / `toBase64` | 約0.66 KiB | 基本の int64・BLOB・保存・復元・SQLite / LTX bytes は一致。全 malformed 入力や全ブラウザの互換性は未検証 |
| `JSON.parse` と enum 変換 | 約2.19 KiB | 数値キーを持つ JSON object の順序が変わり、`json_extract` の結果が不一致 |
| `JSON.stringify` と enum 変換 | 約0.51 KiB | 保存・復元後の結果と SQLite / LTX bytes に不一致 |
| JSON の parse / stringify を両方 | 約2.63 KiB | 互換性未達。削減量の上限を探る試作 |

今回の Chromium 158 は `Uint8Array.fromBase64` / `toBase64` を持ち、Node 24.22.2 はこの二つの API を持たない。**Node 24 にも `Buffer` による Base64 と `atob` / `btoa` はある。** JS backend の薄いアダプターでブラウザの Uint8Array API と Node の Buffer を選べば、ブラウザ専用に限定する必要はない。Wasm GC の portable 実装は別に維持できる。Node の Buffer decode は寛容なので、既存の厳密な入力検証はアダプターでも維持する。約0.66 KiBはブラウザ用置換だけの試作値であり、Node 対応分岐込みの削減量は未計測。[Node 24 Buffer](https://nodejs.org/docs/latest-v24.x/api/buffer.html)、[Uint8Array Base64 API](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array/fromBase64)

JSON は int64、負のゼロ、数値の字句表現、キー順、重複キー、深さ制限、canonical な program ID を保持する必要がある。`JSON.parse` の source 付き reviver と `JSON.rawJSON` は候補になるが、単純な差し替えでは既存の契約を保てなかった。試作結果を本番の削減実績とは扱わない。[parse と精度](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse)、[rawJSON](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/rawJSON)

## 既に標準 API を使う部分と、置換できない部分

- UTF-8 encode / lossy decode は、MoonBit の生成 JS 内で既に `TextEncoder` / `TextDecoder` を使う。BigInt も JS の組み込みを使う。ここを標準化する追加の大幅削減は見込めない。
- AOT ホストの SHA-256 は既に `crypto.subtle.digest`。通常の同期 proof は同期 SHA-256 を transaction 内で使うため、Promise を返す Web Crypto へそのまま置き換えられない。非同期化する場合は原子的な commit の設計も検証する。[digest](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
- LTX v3 の LZ4 は `CompressionStream` に直接置換できない。今回の Chromium では gzip / deflate / deflate-raw が受理され、LZ4 は拒否された。CRC64-ISO も Web Crypto の digest ではない。別 codec に変更すると本家 LTX との互換性を失う。[CompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/CompressionStream/CompressionStream)

LTX transport の遅延 import も試したが、今回の初期 static graph の Brotli 合計は48,248から48,092 bytesへ、**156 bytes**の差だけだった。追加チャンクの HTTP ヘッダーはこの数字に含めない。大きく減ると推測せず、同一ビルド条件の結果で判断する。
