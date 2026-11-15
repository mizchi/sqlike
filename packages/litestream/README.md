# mizchi/litestream

現在は **0.1.0**。一般的なアプリのオフライン更新・復旧・競合解決を、各バックエンドの必須プロファイルで検証した。[対応計画・完了条件](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/roadmap-0.1.0.md)を参照。

DB エンジンに依存しない MoonBit 製の SQLite 同期・LTX 実装。JS / Wasm GC で動作し、LTX v3 の生成・適用、LZ4 / CRC64、SQLite Session codec、revision・適用可否と競合解決を扱う。SQLike・SQLite・Turso のドライバーを本モジュールの依存に含めない。

`moon.pkg` に `"mizchi/litestream"` を import し、`@litestream` から利用する。SQLite イメージを受け取る LTX API は、そのイメージを作成・読取する DB ドライバーから独立している。SQLike なしでの利用を [外部 consumer test](https://github.com/mizchi/sqlike/blob/v0.1.0/tests/workspace.test.ts) で検査する。

ホスト側の [共通契約](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/backend-contract.md) に SQLike / SQLite WASM / Turso WASM のアダプターが従う。三つとも SQL 同期と原子的な outbox 保存を使える。Session capture と SQLite 物理イメージは optional な機能として分け、Turso の現行アダプターは SQL 同期を使う。

SQLike と LTX を組み合わせる AOT export はアプリ側の `examples/aot`、`mizchi/litestream-example/runtime` にある。これにより両ライブラリの依存を独立させている。

ルートの `just test-litestream` で JS / Wasm GC を検証する。`just aot-check /absolute/path/to/litestream` は上流 Go decoder・実 Litestream・SQLite とブラウザで検証する。[全体構成](https://github.com/mizchi/sqlike/blob/v0.1.0/README.md)、[AOT の利用手順](https://github.com/mizchi/sqlike/blob/v0.1.0/docs/aot-ltx-plan.md)を参照。

`moon.mod`に依存を追加する。

```moonbit
import {
  "mizchi/litestream@0.1.0",
}
```
