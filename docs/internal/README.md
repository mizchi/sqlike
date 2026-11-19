# 開発者向けドキュメント

実装経緯、設計、互換性監査、計測、改善計画、リリース作業をまとめる。利用方法は[ユーザー向けガイド](../README.md)を参照。

現在の残タスク・優先順・完了条件は[TODO.md](../../TODO.md)を入口にする。各ページの過去のチェックリストや測定は、その段階の記録として残す。

| ドキュメント | 内容 |
| --- | --- |
| [aot-ltx-plan.md](aot-ltx-plan.md) | 事前コンパイル実行と LTX 生成 |
| [aot-ltx-upload.md](aot-ltx-upload.md) | R02: AOT LTXをNode relay / DOへ送る |
| [aot-outbox-backpressure.md](aot-outbox-backpressure.md) | 満杯時のcheckpoint保留・SQL保存継続・ACK回収後の同期 |
| [aot-performance.md](aot-performance.md) | AOT のサイズと速度 |
| [aot-minimum-size.md](aot-minimum-size.md) | 最小JS AOTのcodec・集約処理の削減と残存箇所 |
| [aot-expression-size.md](aot-expression-size.md) | 5分類の式からdecoder・prepare・evaluateをまとめて除去 |
| [aot-structure-size.md](aot-structure-size.md) | FK・triggerのreaderとFROM・ORDER BY・DISTINCT・LIMITの除去 |
| [aot-compact-size.md](aot-compact-size.md) | struct readerの共通化・FROMなしoptimizer除去と、次の費用の境界 |
| [backend-contract.md](backend-contract.md) | Litestream の DB 契約 |
| [column-delta.md](column-delta.md) | S01: 変更列だけの永続差分 |
| [development.md](development.md) | 開発・検証の記録 |
| [semantic-lint.md](semantic-lint.md) | jev-lintの対象・ルール・APIキー不要のCI検証とリファクタ |
| [do-consumer-sql.md](do-consumer-sql.md) | C02のDO対応: CTE、列RETURNING、metadata |
| [drizzle.md](drizzle.md) | Drizzle・RETURNING・migration |
| [indexeddb-compatibility.md](indexeddb-compatibility.md) | IndexedDB と SQLite 互換性の評価 |
| [incremental-pager.md](incremental-pager.md) | S02初期範囲: UPDATEのページ生成・既存checkpoint接続・原子LTX保存と同条件の計測 |
| [incremental-pager-idb.md](incremental-pager-idb.md) | 実IndexedDB: 通常更新とlogical compactionの時間・提出record・メモリ |
| [incremental-logical-checkpoint.md](incremental-logical-checkpoint.md) | 変更行chunkだけのcheckpoint・世代CAS・原子的GCと比較 |
| [logical-snapshot-chunks.md](logical-snapshot-chunks.md) | 論理snapshotのbinary行分割・旧JSON移行・原子保存と計測 |
| [ltx-page-checksums.md](ltx-page-checksums.md) | ページ単位のbinary CRC・旧JSON移行と同じbundleによる比較 |
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
| [release-0.2.0-preparation.md](release-0.2.0-preparation.md) | 0.2.0候補の英語化・配布検証と公開前の残確認 |
| [releasing.md](releasing.md) | リリース手順 |
| [roadmap-0.1.0.md](roadmap-0.1.0.md) | 0.1.0 の対応範囲と受入条件 |
| [row-store.md](row-store.md) | P02: 変更表内のコピーをページ単位にする |
| [runtime-size.md](runtime-size.md) | バンドルサイズの計測記録 |
| [readme-charts.md](readme-charts.md) | READMEの比較図・数値表の再生成と検証 |
| [schema-expressions.md](schema-expressions.md) | 式DEFAULT、CTAS初期行、binary kind 7と評価コスト |
| [schema-metadata.md](schema-metadata.md) | 名前衝突、schema affinity、物理metadataの拒否とadapter列挙契約 |
| [in-list-performance.md](in-list-performance.md) | 行値metadata・IN索引・slot集約のpaired速度と容量 |
| [sqlike-app-features.md](sqlike-app-features.md) | 一般的なアプリ向けの追加機能 |
| [sqlike-development.md](sqlike-development.md) | SQLike の互換性と速度 |
| [sqlike-feature-profiles.md](sqlike-feature-profiles.md) | 機能を選択するランタイム |
| [sqlike-build-contract.md](sqlike-build-contract.md) | baseline / full / AOT、2種類の出力、依存グラフとZ3の検証範囲 |
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
| [staged-sqlite-compatibility.md](staged-sqlite-compatibility.md) | 不足するSQLite互換機能の導入順・任意機能の境界・サイズ差 |
| [wasm-performance.md](wasm-performance.md) | SQLike の JS / Wasm GC 実行速度 |
| [web-platform-size.md](web-platform-size.md) | Web 標準による削減候補 |
