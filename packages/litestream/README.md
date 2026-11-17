# mizchi/litestream

DBエンジンに依存しないSQLite同期・LTXのMoonBitモジュールです。JS / Wasm GCに対応し、SQLike・SQLite・Tursoの本体を依存に含めません。

```sh
moon add mizchi/litestream@0.1.2
```

`moon.pkg`から`"mizchi/litestream"`をimportし、`@litestream`のAPIを使います。

- LTX v3の生成・適用、TXIDとchecksumの検査。
- SQLite Session changesetのdecodeとSQL適用計画。
- transport frameのencode / decode、revisionと適用可否の判定。
- LZ4 / CRC64。

SQLite画像を受け取るLTX APIは、その画像を作るDBドライバーから独立しています。SessionやLTXに必要なdriverの能力は、利用側で提供します。

JavaScript / TypeScriptのhost APIは`@mizchi/litestream`です。HTTP / P2P transport、オフライン編集、再送、利用側policyによる競合処理を組み込めます。

[同期・競合処理・LTXの利用ガイド](https://github.com/mizchi/sqlike/blob/main/docs/sync.md) / [全体の導入](https://github.com/mizchi/sqlike)。MIT。
