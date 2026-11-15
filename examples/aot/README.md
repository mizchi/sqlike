# AOT 統合サンプル

`mizchi/litestream-example` は SQLike と Litestream を組み合わせるアプリ用モジュール。`src/runtime` がブラウザ向けの DB 実行・SQLite writer・LTX reader / writer を export する。SQL parser は配信ランタイムに含めない。

ライブラリの `mizchi/sqlike` と `mizchi/litestream` は相互に依存せず、サンプルが両者に依存する。`moon.work` からまとめてビルドする。

`just build-lite` 後に `/lite/` を開く。[カタログ](../notes/catalog.json)、[利用手順](../../docs/aot-ltx-plan.md)を参照。
