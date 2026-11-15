# Litestream の DB 契約

`mizchi/litestream` は SQLike / SQLite / Turso に依存しない。バイナリ形式、LTX、適用可否と利用側ポリシーを扱い、DB の実行・永続化はホストアダプターへ渡す。`mizchi/sqlike` も Litestream に依存しない。両者の AOT 統合はサンプルの `mizchi/litestream-example` が担当する。

ホストの最小契約は [Database](../src/contract.ts)。`all` / `run` / `transaction` を提供し、データと outbox を同じ transaction に入れる。Session capture は optional。存在しない機能のために、常に失敗する仮の実装を要求しない。SQL 同期は Session API のない DB でも動く。

ブラウザでは [BrowserDatabase](../src/backend-contract.ts) の `query` が書込を拒否する読み取り API を提供する。[factory](../adapters/browser-database.ts) は選択した SDK だけを遅延 import し、アダプターの実装が [capabilities](../src/browser-engine.ts) と一致することを検査する。

| ブラウザ DB | SQL 同期 | Session 差分の生成 | Session 差分の受信 | 物理 SQLite / LTX の読取 |
| --- | --- | --- | --- | --- |
| `sqlike` | 対応 | 対応 | 対応 | 対応 |
| `sqlite` | 対応 | 対応 | 対応 | 対応 |
| `turso` | 対応 | 現行 SDK では未対応 | MoonBit decoder と SQL 適用で対応 | 現行アダプターでは未対応 |

これはアダプターの検証済み機能表であり、三つのエンジンの SQL 全機能が同一という宣言ではない。Session の生成には非 NULL の宣言済み主キーなどの制約があり、LTX は一つの物理履歴と base checksum に属する。

Turso は既定で SQL mode を選ぶ。未対応の Session capture / 直接 LTX が明示的に要求された場合は、変更前に構造化した `unsupported` を返す。他のエンジンへの fallback や、SQL をバイナリ複製と偽る処理は行わない。Turso との同期には Node / DO / peer / peer-do の論理経路、またはサーバーで復元した snapshot を使える。

`engine=sqlike` が正式名で、`engine=moonbit` は互換 alias。既存の IndexedDB / OPFS の保存名を引き継ぐ。DB を選び直すことは既存保存領域の自動変換ではない。

[混在ブラウザテスト](../e2e/backends.spec.ts) は本物の三つの DB を同一の正本に接続し、int64・BLOB・オフライン再読込と収束を検証する。古い SQL の base は保留し、利用側が選択した主キーへの明示的な再適用を経て収束させる。Session は旧値の検査を通った独立変更を受理できる。Native SQLite の読取 API と、SQLike / Turso の `query` も書込を拒否する。
