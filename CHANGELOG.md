# Changelog

## [0.1.0] - 2026-11-16

### Added

- 独立したMoonBitモジュール `mizchi/sqlike` と `mizchi/litestream`。JS / Wasm GCに対応。
- SQLiteサブセットの動的SQL・AOT実行、RETURNING、index、基本trigger、FK、STRICT、RIGHT / FULL JOIN。
- 固定DDLとprepared statementのバイナリ定義、パーサを含まない実行ランタイム、機能別ビルドとOxc圧縮。
- IndexedDBの原子的な行ジャーナル・変更列patch、世代CAS、オフライン再開とACK消失時の復旧。
- SQLite / SQLike / Tursoの同期adapter、利用側の適用可否・競合policy、Node relay / Durable Objects / P2P relayの検証構成。
- LTX v3の生成・直接適用と本家Litestreamでの復元検証。
- 任意のDrizzle adapterと、固定バージョンのDrizzle Kitによるmigration検証。
- native SQLiteとの差分検査、失敗後の非変更検査、Chromiumでの保存・同期E2Eとサイズ・速度計測。

### Changed

- 行ストアのCOWページ、共有する主キー索引、増分更新、AOTの列metadata再利用で、検索・更新・cloneと保存を改善。

対応範囲・導入時の制約は[リリースノート](docs/releases/v0.1.0.md)を参照。SQLite全機能互換は未達。全文検索は任意パッケージ、LSMは実験専用で通常バンドルに含めない。

[0.1.0]: https://github.com/mizchi/sqlike/releases/tag/v0.1.0
