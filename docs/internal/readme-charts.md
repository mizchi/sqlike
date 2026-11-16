# READMEの比較図

`docs/images/bundle-size.svg`と`sqlite-benchmark.svg`を英語の`README.md`と日本語の`README.ja.md`に共通で埋め込む。クリック先には同じ図のPNGを置く。数値表は折りたたんで残す。

バンドルサイズと速度の生成処理は両READMEを更新・照合する。数値は共通の計測データを使い、見出しと項目名を言語ごとに変える。本文の翻訳を表の再生成で上書きしない。

Mermaidの[XY chart](https://mermaid.js.org/syntax/xyChart.html)にも横棒グラフはあるが、この比較では10構成の対数目盛と、7処理別の独立した軸・サンプル範囲を表示するためMatplotlibを使う。[GitHubのMermaidサポート](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams)のバージョン差にも依存しない。

```sh
just readme-charts          # 記録済みの測定データからSVG・PNGと速度表を再生成
just readme-charts --check  # 入力・renderer・画像のhashと数値を照合
```

Python 3とuvを使う。描画依存はPEP 723のscript metadataに固定し、uvの隔離環境に入れる。アプリやnpmパッケージの実行依存には追加しない。

サイズは`measurements/bundle-size-current.json`の全10構成、raw / BrotliのbytesをそのままKiBへ変換する。`just bundle-size`は測定と表更新の後に図も再生成する。点と接続線を使い、対数軸の棒の長さを量と誤解させない。軸とREADME本文に対数目盛であることを示す。

速度は`measurements/sqlite-speed-current.json`の5,000行・coldRows=0を使用する。通常SQLのJS / Wasm GC、SQLite通常 / preparedの4経路について、各sampleをμs/操作へ変換してから中央値を求める。更新の図は同値UPDATEではなく、`indexLifecycle`の値を交互に変える更新＋範囲検索を使う。ひげは実測の最小〜最大で、信頼区間ではない。全件取得の図のみmsへ換算し、表はμsのままにする。

`just sqlite-bench --profiles=false`で速度を再計測した後も`just readme-charts`を実行する。測定環境・versionが変わった場合はREADME本文の条件も更新する。起動や永続化を含む性能、異なるエンジン間の完全な機能同等性は主張しない。

`docs/images/comparison-data.json`には元のJSONとrenderer、生成画像のSHA-256、および描画した全数値を保存する。更新時は実画像とREADME幅での表示を確認する。
