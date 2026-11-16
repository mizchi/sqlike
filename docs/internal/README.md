# 開発者向けドキュメント

実装経緯、設計、互換性監査、計測、改善計画、リリース作業をまとめる。利用方法は[ユーザー向けガイド](../README.md)を参照。

| ドキュメント | 内容 |
| --- | --- |
| [aot-ltx-plan.md](aot-ltx-plan.md) | 事前コンパイル実行と LTX 生成 |
| [aot-ltx-upload.md](aot-ltx-upload.md) | R02: AOT LTXをNode relay / DOへ送る |
| [aot-performance.md](aot-performance.md) | AOT のサイズと速度 |
| [backend-contract.md](backend-contract.md) | Litestream の DB 契約 |
| [column-delta.md](column-delta.md) | S01: 変更列だけの永続差分 |
| [development.md](development.md) | 開発・検証の記録 |
| [do-consumer-sql.md](do-consumer-sql.md) | C02のDO対応: CTE、列RETURNING、metadata |
| [drizzle.md](drizzle.md) | Drizzle・RETURNING・migration |
| [indexeddb-compatibility.md](indexeddb-compatibility.md) | IndexedDB と SQLite 互換性の評価 |
| [indexeddb-persistence.md](indexeddb-persistence.md) | IndexedDB の差分保存とページ保存の比較 |
| [json-abi.md](json-abi.md) | JSON境界とmizchi/x/jsonの評価 |
| [lsm-experiment.md](lsm-experiment.md) | MoonBit LSM 実験 |
| [minification.md](minification.md) | JSの追加圧縮の比較 |
| [moon-sql.md](moon-sql.md) | MoonBit 製 SQL エンジン |
| [npm-release.md](npm-release.md) | npm配布 |
| [p0-results.md](p0-results.md) | P0の実施結果とP01着手前の計測基準 |
| [p01-aot-results.md](p01-aot-results.md) | P01: AOTの実行準備と結果変換の改善 |
| [predefined-binary.md](predefined-binary.md) | 固定DDLとprepared statementのバイナリ初期化 |
| [release-acceptance.md](release-acceptance.md) | 0.1.0の受入プロファイルとP0チェックリスト |
| [releasing.md](releasing.md) | リリース手順 |
| [roadmap-0.1.0.md](roadmap-0.1.0.md) | 0.1.0 の対応範囲と受入条件 |
| [row-store.md](row-store.md) | P02: 変更表内のコピーをページ単位にする |
| [runtime-size.md](runtime-size.md) | バンドルサイズの計測記録 |
| [readme-charts.md](readme-charts.md) | READMEの比較図・数値表の再生成と検証 |
| [sqlike-app-features.md](sqlike-app-features.md) | 一般的なアプリ向けの追加機能 |
| [sqlike-development.md](sqlike-development.md) | SQLike の互換性と速度 |
| [sqlike-feature-profiles.md](sqlike-feature-profiles.md) | 機能を選択するランタイム |
| [sqlike-incremental-index.md](sqlike-incremental-index.md) | 二次索引の増分更新 |
| [sqlike-index-trigger.md](sqlike-index-trigger.md) | 複合 index・部分 / 式 index・基本 trigger |
| [sqlike-optimization-plan.md](sqlike-optimization-plan.md) | SQLike 改善計画 |
| [sqlike-secondary-index.md](sqlike-secondary-index.md) | 単一列の二次索引による範囲検索 |
| [sqlite-conformance.md](sqlite-conformance.md) | 本家 SQLite との SQL 差分テスト |
| [sqlite-differential-findings.md](sqlite-differential-findings.md) | SQLite差分の修正と性能改善 |
| [sqlite-feature-audit.md](sqlite-feature-audit.md) | SQLite 全機能の互換性監査 |
| [sqlite-output-compatibility.md](sqlite-output-compatibility.md) | 出力互換を優先する契約 |
| [sqlite-performance.md](sqlite-performance.md) | SQLite WASM と SQLike の速度差・最適化候補 |
| [status-and-improvement-plan.md](status-and-improvement-plan.md) | 現在の対応範囲・最適化と改善対象 |
| [wasm-performance.md](wasm-performance.md) | SQLike の JS / Wasm GC 実行速度 |
| [web-platform-size.md](web-platform-size.md) | Web 標準による削減候補 |
