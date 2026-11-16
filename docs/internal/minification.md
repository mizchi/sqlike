# JSの追加圧縮の比較

2026-11-16、0.0.1時点のソースをTerser 5.51.2 / Node 24.22.2で測定した。実験結果は[計測JSON](../../measurements/minification-current.json)、手順は[プローブ](../../measurements/minification-probe.mjs)へ保存した。比較試験ではruntime依存・ルートのpackage.json / lockfileを変更していない。比較後、選択ランタイムの生成へOxc minifyを採用した。

```sh
just probe-minification
```

Terserをリポジトリ外の`/tmp/browser-litestream-terser-tools`へ固定バージョンで入れ、3つのJS実行コアを隔離ビルドする。試験用JSは`generated/terser-probe`へ出力する。SQLパーサを含まないバイナリ定義の実行APIを保持し、host / IndexedDB / catalog / SQLite exporter / LTXはサイズに含めない。

## 採用したOxc設定

`just sqlike-runtime` / `buildSqlikeRuntime()`の生成JSは、既定でOxcにより空白と識別子を圧縮する。`aot` / `sql` / `defined`の各モードに適用し、公開exportはstrictに維持する。プロパティ名はmangleしない。`profile.json`に`minify: "oxc"`を記録する。調査用のMoon出力はTypeScript APIの`{minify: false}`で生成できる。

[共通設定](../../scripts/oxc-runtime.ts)でpurity annotationとlicense commentを残す。[契約テスト](../../tests/oxc-runtime.test.ts)は圧縮後のexport・property key・SQL結果と、二段目のbundlerが未使用exportを落とせることを検査する。通常のアプリビルドも`build.minify: "oxc"`を明示した。

採用後の主キー索引だけのコアはBrotli **81.09 KiB**、host / 保存adapter込みで**85.14 KiB**。[選択ビルド計測](../../measurements/optional-functions-current.json)の生成物そのものを計測し、非圧縮のaudit用出力とは分ける。以下は採用判断に使った比較試験であり、annotationを残さないclient試験などと採用後の値には小差がある。

## 空白とminifierの差

これまでの単体計測はViteのESライブラリモードで、識別子や構文の圧縮後も空白を保持していた。[Viteの仕様](https://vite.dev/config/build-options.html#build-minify)に沿う動作であり、その値を最終配信用の完全な圧縮と混同しない。通常のアプリ配信の計測は別で、元からclientビルドを使用する。

同じ公開exportを保持するOxcのclientビルドと、その後にTerserを適用した場合を比較した。gzipはlevel 9、Brotliはquality 11、ファイルごとに計測する。

| 主キー索引だけのJSコア | raw | Brotli |
| --- | ---: | ---: |
| 本試験のOxc ESライブラリ形式 | 615.15 KiB | 93.25 KiB |
| Oxc client形式 | 412.68 KiB | 81.14 KiB |
| Oxc client → Terser 2パス | 389.60 KiB | 79.89 KiB |

大部分は空白の除去による差。追加のTerserだけの効果は、client形式に対してBrotli **1,287 B（1.26 KiB、約1.55%）**。ライブラリ形式からの減少をすべてTerserの最適化による効果として扱わない。

| JSコア | Oxc client・Brotli | その後Terser 2パス | 差 |
| --- | ---: | ---: | ---: |
| 主キー索引だけ | 81.14 KiB | 79.89 KiB | 1.26 KiB |
| JSON / 日時 / windowを除去 | 83.98 KiB | 82.83 KiB | 1.15 KiB |
| 全実行機能 | 90.86 KiB | 89.59 KiB | 1.27 KiB |

既存の本番AOT Workerにもサイズ試験だけ行い、Brotli **108,085→106,364 B**（2パス）だった。このWorkerのTerser生成物をブラウザで検証したものではなく、既定の配信ファイルへは適用していない。入力Workerが存在しない環境では、この追加サイズ試験を行わない。

## 名前の短縮

生成直後のMoonBit JSには長い`_M...`名があるが、Oxcで計測したコアではほぼ短縮済みだった。残る名前は主に`capacity_mask`、`decimal_point`、`window_values`等のプロパティ。識別子のmangleとプロパティのmangleは別の処理になる。

`$tag`・`_0`等の生成名と、10個の内部プロパティに限定したallowlistも試した。主キー索引だけのコアでは、同じライブラリ入力へのTerser 2パス **81,700 B**から**81,395 B**へ、Brotliで**305 B**減少した。rawでは11,597 B減るが、繰り返す名前は転送時の圧縮でも縮むため、配信量の効果は小さい。全実行機能ではallowlistを広げると狭い指定よりBrotliが大きくなる例もあった。

任意のプロパティを一括でmangleする設定は試していない。JSON / wire / host ABIや別chunkの名前も変わり得るため、採用時には境界を指定する必要がある。[Terserのreserved / keep_quoted設定](https://terser.org/docs/options/#mangle-properties-options)だけで未知の動的アクセスまで保証できるものではない。

## 検証と判断

3プロファイル×11構成の各々について、上流select1の1,000クエリを本家SQLiteと比較し、計33,000クエリが一致した。公開exportと、圧縮前コアと同じバイナリsnapshot、int64・負のゼロ・BLOB・BOM / NUL、失敗したPK書込・transaction rollback・破損snapshotの拒否を照合した。全機能プロファイルはJSON / 日時 / window / STRICT / FK / trigger / DEFAULTも元のコアと照合した。これらの追加機能すべてを新たに本家と差分検証したという意味ではない。

Terserは`module: true`、`ecma: 2022`、`compress.passes: 2`、通常の識別子mangle、`preserve_annotations: true`を基本とした。`unsafe`系の最適化は有効にしていない。`passes: 3`はrawが減ってもBrotliが増える例があり、既定値としては2パスを候補にする。通常のbundlerで到達性解析をした後のTerserが、MoonBitの生JSをTerserだけで処理する構成より小さかった。

Oxcを生成JSの既定に採用し、Terserの追加パスと内部プロパティの短縮は比較試験として維持する。Oxcの採用はNodeの型・SQLite差分と、ブラウザのIndexedDB / オフライン再開で確認した。Terserの検証はNode上のコアを対象とし、採用する際には対象chunkのブラウザ動作とtree shaking、起動・実行速度を別に確認する。圧縮処理時間はJSONに参考値として残すが、実行速度の改善や全入力の同値性を示す測定ではない。
